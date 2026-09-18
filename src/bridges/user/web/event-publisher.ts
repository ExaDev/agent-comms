/**
 * In-memory, resumable event publisher for the web UI's subscribeEvents stream.
 *
 * oRPC v2 beta (`\@orpc/server`, `\@orpc/client`, `\@orpc/contract` at 2.0.0-beta.35 -- confirmed against the actual published tarballs, not just docs) ships no MemoryPublisher/EventPublisher class. This is a hand-written equivalent built on the primitives that do exist: a plain async generator (satisfies AsyncIteratorObject on its own) and withEventMeta (from `\@standard-server/core`, re-exported by `\@orpc/server`) to tag each published event with a monotonic id oRPC's own RetryLinkPlugin already knows how to read back as lastEventId on reconnect.
 *
 * One instance per WebServerHandle -- not a module-level singleton -- so multiple concurrent web server instances (multiple bridges each starting their own web UI) never share replay buffers.
 */

import { withEventMeta } from "@orpc/server";
import type { MeshEvent } from "./contract.js";

/** A plain function call is opaque to TS's control-flow narrowing, unlike a direct `signal?.aborted` comparison -- narrowing that across an `await` (the abort can genuinely flip mid-wait) produces a false "these types have no overlap" error at the re-check below the await. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export interface MeshEventPublisherOptions {
  /** How long a published event stays available for replay by a resuming subscriber. */
  retentionMs?: number;
}

const DEFAULT_RETENTION_MS = 60_000;

interface BufferedEvent {
  id: string;
  event: MeshEvent;
  publishedAt: number;
}

export interface MeshEventSubscribeOptions {
  signal?: AbortSignal;
  lastEventId?: string;
}

export class MeshEventPublisher {
  private seq = 0;
  private readonly buffer: BufferedEvent[] = [];
  private readonly listeners = new Set<(event: MeshEvent) => void>();
  private readonly retentionMs: number;

  constructor(options: Readonly<MeshEventPublisherOptions> = {}) {
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  }

  publish(event: MeshEvent): void {
    this.prune();
    const id = String(++this.seq);
    const tagged = withEventMeta(event, { id });
    this.buffer.push({ id, event: tagged, publishedAt: Date.now() });
    for (const listener of this.listeners) listener(tagged);
  }

  private prune(): void {
    const cutoff = Date.now() - this.retentionMs;
    while (
      this.buffer.length > 0 &&
      (this.buffer[0]?.publishedAt ?? Infinity) < cutoff
    ) {
      this.buffer.shift();
    }
  }

  /**
   * Replays buffered events after `lastEventId` (or every buffered event, if a resuming subscriber's `lastEventId` has already aged out of the retention window), then yields new events as they're published until `signal` aborts.
   */
  async *subscribe(
    options: Readonly<MeshEventSubscribeOptions> = {},
  ): AsyncGenerator<MeshEvent, void, void> {
    const { signal, lastEventId } = options;
    this.prune();

    if (lastEventId !== undefined) {
      const startIndex = this.buffer.findIndex((b) => b.id === lastEventId);
      const replay =
        startIndex === -1 ? this.buffer : this.buffer.slice(startIndex + 1);
      for (const buffered of replay) {
        if (isAborted(signal)) return;
        yield buffered.event;
      }
    }

    const queue: MeshEvent[] = [];
    let wake: (() => void) | undefined;
    const listener = (event: MeshEvent): void => {
      queue.push(event);
      wake?.();
    };
    this.listeners.add(listener);

    try {
      for (;;) {
        if (isAborted(signal)) return;
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
            signal?.addEventListener(
              "abort",
              () => {
                resolve();
              },
              { once: true },
            );
          });
          wake = undefined;
          if (isAborted(signal)) return;
        }
        const next = queue.shift();
        if (next !== undefined) yield next;
      }
    } finally {
      this.listeners.delete(listener);
    }
  }
}

/**
 * In-memory, resumable event publisher for the web UI's subscribeEvents stream.
 *
 * oRPC v2 beta (`\@orpc/server`, `\@orpc/client`, `\@orpc/contract` at 2.0.0-beta.35 -- confirmed against the actual published tarballs, not just docs) ships no MemoryPublisher/EventPublisher class. This is a hand-written equivalent built on the primitives that do exist: a plain async generator (satisfies AsyncIteratorObject on its own) and withEventMeta (from `\@standard-server/core`, re-exported by `\@orpc/server`) to tag each published event with an id oRPC's own RetryLinkPlugin already knows how to read back as lastEventId on reconnect. An id is `<instance>.<seq>`: the instance is drawn at random when the publisher starts, so an id from before a restart, or from another publisher, can never be mistaken for one of this publisher's events.
 *
 * One instance per WebServerHandle -- not a module-level singleton -- so multiple concurrent web server instances (multiple bridges each starting their own web UI) never share replay buffers.
 */

import { withEventMeta } from "@orpc/server";
import type { MeshEvent } from "./contract.js";
import {
  ID_SEPARATOR,
  INSTANCE_BYTES,
  MAX_EVENT_ID_LENGTH,
} from "./event-id.js";

/** A plain function call is opaque to TS's control-flow narrowing, unlike a direct `signal?.aborted` comparison -- narrowing that across an `await` (the abort can genuinely flip mid-wait) produces a false "these types have no overlap" error at the re-check below the await. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export interface MeshEventPublisherOptions {
  /** How long a published event stays available for replay by a resuming subscriber. */
  retentionMs?: number;
  /** The most events kept for replay. Defaults to {@link DEFAULT_MAX_BUFFERED_EVENTS}. */
  maxBufferedEvents?: number;
}

const DEFAULT_RETENTION_MS = 60_000;

/** The most events a publisher keeps for replay, whatever their age. An event can carry a whole mesh snapshot, so a burst of resynchronisations must not hold sixty seconds of them: past this a subscriber whose id fell off the end starts from a snapshot, as one whose id aged out does. */
const DEFAULT_MAX_BUFFERED_EVENTS = 1_000;

/** Radix of the hex form of the instance. */
const HEX_RADIX = 16;

interface BufferedEvent {
  seq: number;
  event: MeshEvent;
  publishedAt: number;
}

export interface MeshEventSubscribeOptions {
  signal?: AbortSignal;
  lastEventId?: string;
  /** Builds the snapshot a subscriber starts from when it has no usable id. The snapshot is built after the subscriber is listening, so no event published meanwhile is lost. */
  snapshot: () => MeshEvent;
}

function drawInstance(): string {
  return Array.from(
    globalThis.crypto.getRandomValues(new Uint8Array(INSTANCE_BYTES)),
    (byte) => byte.toString(HEX_RADIX).padStart(2, "0"),
  ).join("");
}

export class MeshEventPublisher {
  private seq = 0;
  private readonly instance = drawInstance();
  private readonly buffer: BufferedEvent[] = [];
  private readonly listeners = new Set<(event: MeshEvent) => void>();
  private readonly retentionMs: number;
  private readonly maxBufferedEvents: number;

  constructor(options: Readonly<MeshEventPublisherOptions> = {}) {
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.maxBufferedEvents =
      options.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS;
  }

  publish(event: MeshEvent): void {
    this.prune();
    const seq = ++this.seq;
    const tagged = withEventMeta(event, {
      id: `${this.instance}${ID_SEPARATOR}${String(seq)}`,
    });
    this.buffer.push({ seq, event: tagged, publishedAt: Date.now() });
    // Sequence numbers stay contiguous, so dropping from the head leaves "older than the oldest retained" exact.
    while (this.buffer.length > this.maxBufferedEvents) this.buffer.shift();
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
   * The events a subscriber holding `lastEventId` is missing, or undefined when they cannot be known: the id is not this publisher's, is malformed, or is older than the oldest retained event, so events between it and the retained ones are gone.
   */
  private missedSince(lastEventId: string): BufferedEvent[] | undefined {
    // Refused before any split: no id of any publisher is this long.
    if (lastEventId.length > MAX_EVENT_ID_LENGTH) return undefined;
    const [instance, rawSeq, ...rest] = lastEventId.split(ID_SEPARATOR);
    if (instance !== this.instance || rawSeq === undefined || rest.length > 0) {
      return undefined;
    }
    if (!/^[0-9]+$/u.test(rawSeq)) return undefined;
    const seq = Number(rawSeq);
    if (seq > this.seq) return undefined;
    const oldest = this.buffer[0];
    // With nothing retained the only id that is not missing anything is the latest one.
    if (oldest === undefined) return seq === this.seq ? [] : undefined;
    if (seq < oldest.seq - 1) return undefined;
    return this.buffer.filter((buffered) => buffered.seq > seq);
  }

  /**
   * Starts a subscriber and yields to it until `signal` aborts. A subscriber with a usable `lastEventId` first gets exactly the events it missed. Any other subscriber, with no id or with one that cannot be resumed from (see {@link MeshEventPublisher.missedSince}), first gets `snapshot()`. Live events follow in both cases, and none published while the replay or snapshot is being delivered is lost.
   */
  async *subscribe(
    options: Readonly<MeshEventSubscribeOptions>,
  ): AsyncGenerator<MeshEvent, void, void> {
    const { signal, lastEventId, snapshot } = options;
    this.prune();

    const queue: MeshEvent[] = [];
    let wake: (() => void) | undefined;
    const listener = (event: MeshEvent): void => {
      queue.push(event);
      wake?.();
    };
    this.listeners.add(listener);

    try {
      const missed =
        lastEventId === undefined ? undefined : this.missedSince(lastEventId);
      if (missed === undefined) {
        yield snapshot();
      } else {
        for (const buffered of missed) {
          if (isAborted(signal)) return;
          yield buffered.event;
        }
      }
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

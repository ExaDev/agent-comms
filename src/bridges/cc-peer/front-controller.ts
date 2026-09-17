/**
 * CcPeerFront — coordinator-only periodic controller for the default cc-peer front (agent-comms#157), attaching and detaching fronted sessions on each poll tick. Mirrors StaleAgentChecker's own "coordinator-only periodic probe" shape (owns its own interval timer exclusively, start/stop, no immediate first tick) since both are the same kind of thing: a background job that only ever runs on this machine's current mesh coordinator.
 *
 * Kept free of any real cc-peer/MeshStore construction, exactly like front.ts's pure decision logic this class is built on -- every real I/O (listRoster, probeSlotOwner, attach, detach) is injected, so the attach/detach/yield diffing across ticks is testable with fake timers and no real local Claude Code session. front-runtime.ts supplies the real dependencies.
 */

import {
  selectSessionsToFront,
  matchInboundMessageSession,
  type CcPeerRosterEntryLike,
} from "./front.js";
import type { IdentitySlot } from "../../core/identity-store.js";

/** How often the front re-enumerates the local cc-peer roster and re-probes every currently-fronted session's own slot. */
const DEFAULT_POLL_INTERVAL_MS = 5000;

/** The minimum shape a fronted-session record must carry so CcPeerFront can track and route to it, regardless of whatever real MeshStore/CommsTool state a concrete implementation (front-runtime.ts) attaches alongside these fields. */
export interface FrontedSessionRecord {
  readonly pid: number;
  readonly cwd: string;
  readonly messagingSocketPath: string;
  /** Delivers an inbound cc-peer message addressed to this fronted session into the mesh (the session-to-mesh direction) -- wired by attach() itself, exactly as wireCcPeerBridge's own peer.on("message") handler does for the one-shot bridge command. */
  readonly handleInbound: (
    message: Readonly<{ from?: string; fromName?: string; body: string }>,
  ) => void;
  /** Routes a reply arriving on one of this session's own reply aliases into a mesh DM addressed to the correspondent that alias stands for, sent as this session's own device-id (agent-comms#158) -- the session-to-mesh direction for lazy per-correspondent aliases. Only called once handleAliasMessage has already resolved the alias to a known correspondent; a stale alias goes to notifyStaleAlias instead. */
  readonly handleAliasReply: (
    correspondentId: string,
    message: Readonly<{ from?: string; fromName?: string; body: string }>,
  ) => void;
  /** Delivers a clear error back into this session when a reply arrives on an alias the directory no longer maps to any correspondent -- e.g. after a front restart, since reply aliases are ephemeral by design -- rather than silently dropping the reply. */
  readonly notifyStaleAlias: (aliasName: string) => void;
}

/** The narrow slice of ReplyAliasDirectory (reply-aliases.ts) CcPeerFront needs to resolve an inbound alias message's own correspondent -- narrowed rather than importing the class directly so front-controller.ts stays free of any construction concern, matching probeSlotOwner's own injected-function convention. */
export interface CcPeerFrontAliasDirectory {
  correspondentFor: (aliasName: string) => string | undefined;
}

export interface CcPeerFrontDeps<TRecord extends FrontedSessionRecord> {
  /** Enumerates the current local cc-peer roster. Rejects propagate to onError rather than throwing out of the poll timer. */
  listRoster: () => Promise<readonly CcPeerRosterEntryLike[]>;
  /** Read-only probe of a slot's current lock holder -- identity-store.ts's probeSlotOwner in production. */
  probeSlotOwner: (slot: Readonly<IdentitySlot>) => number | undefined;
  /** Builds a fronted-session record for a newly-selected roster entry (mints/loads its identity, wires the mesh store and the inbound relay). Rejects propagate to onError; the entry is retried on the next tick. */
  attach: (entry: Readonly<CcPeerRosterEntryLike>) => Promise<TRecord>;
  /** Tears a fronted-session record down (marks its agent offline, shuts its mesh store down). Rejects propagate to onError. */
  detach: (record: TRecord) => Promise<void>;
  /** Resolves an inbound alias message's own alias name back to the correspondent it stands for -- reply-aliases.ts's ReplyAliasDirectory in production. */
  aliasDirectory: CcPeerFrontAliasDirectory;
  pollIntervalMs?: number | undefined;
  onError?: ((error: Error) => void) | undefined;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export class CcPeerFront<TRecord extends FrontedSessionRecord> {
  private readonly fronted = new Map<number, TRecord>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: Readonly<CcPeerFrontDeps<TRecord>>) {}

  /** Starts the periodic poll (coordinator-only). No-op if already running. Matches StaleAgentChecker's own convention of no immediate first tick -- the first attach happens on the first elapsed interval, not synchronously on start(). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  }

  /** Stops the periodic poll and detaches every currently-fronted session -- this side is no longer the coordinator, so it has no business still relaying on any session's behalf. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    const records = [...this.fronted.values()];
    this.fronted.clear();
    for (const record of records) {
      await this.detachOne(record);
    }
  }

  /** Routes an inbound cc-peer message to whichever fronted session it came from, if any -- the shared front-wide CcPeer instance's own "message" listener calls this directly (front-runtime.ts), since only this class knows the current fronted set. A message matching no fronted session (already detached, or genuinely foreign) is silently dropped -- there's nowhere for it to go. */
  handleInboundMessage(
    message: Readonly<{ from?: string; fromName?: string; body: string }>,
  ): void {
    const record = matchInboundMessageSession(this.fronted.values(), message);
    record?.handleInbound(message);
  }

  /** Routes a reply arriving on a shared reply alias to whichever fronted session actually sent it -- matched the same way as handleInboundMessage, by the envelope's own socket-path convention. A message matching no fronted session is silently dropped, same as handleInboundMessage: there is nowhere for it to go, and we cannot safely address an error back to a session we do not control. Once the sending session is identified, the alias directory resolves which correspondent this reply is for; an alias the directory no longer knows about is reported back into the session as a stale-alias error rather than silently dropped, per agent-comms#158. */
  handleAliasMessage(
    message: Readonly<{ alias: string; from?: string; body: string }>,
  ): void {
    const record = matchInboundMessageSession(this.fronted.values(), message);
    if (!record) return;
    const correspondentId = this.deps.aliasDirectory.correspondentFor(
      message.alias,
    );
    if (correspondentId === undefined) {
      record.notifyStaleAlias(message.alias);
      return;
    }
    record.handleAliasReply(correspondentId, message);
  }

  private async tick(): Promise<void> {
    let roster: readonly CcPeerRosterEntryLike[];
    try {
      roster = await this.deps.listRoster();
    } catch (err) {
      this.deps.onError?.(toError(err));
      return;
    }

    const selected = selectSessionsToFront(roster, this.deps.probeSlotOwner);
    const selectedPids = new Set(selected.map((entry) => entry.pid));
    const rosterPids = new Set(roster.map((entry) => entry.pid));

    // Detach anything that either exited (gone from the roster entirely) or yielded (its own slot is now held by a live bridge, so it's no longer in the selected set even though the session process itself is still running).
    for (const [pid, record] of [...this.fronted]) {
      if (rosterPids.has(pid) && selectedPids.has(pid)) continue;
      this.fronted.delete(pid);
      await this.detachOne(record);
    }

    for (const entry of selected) {
      if (this.fronted.has(entry.pid)) continue;
      try {
        const record = await this.deps.attach(entry);
        this.fronted.set(entry.pid, record);
      } catch (err) {
        this.deps.onError?.(toError(err));
      }
    }
  }

  private async detachOne(record: TRecord): Promise<void> {
    try {
      await this.deps.detach(record);
    } catch (err) {
      this.deps.onError?.(toError(err));
    }
  }
}

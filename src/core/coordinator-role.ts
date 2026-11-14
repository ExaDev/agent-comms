/**
 * CoordinatorRole: the elected holder of this machine's coordinator duties (agent-comms#341), the stale-agent PID probe, single-authority departure announcements, and the default cc-peer front. Held by gossiped, term-based claim (wire-mesh-core's CoordinatorElection over the spec's coordinator-frame) rather than by whoever binds the well-known port: a higher term always supersedes a lower one, an equal term breaks by lowest device-id, and any live peer can take the role over by raising the term, so a peer that never bound the port can hold it and the port stays only a compatibility first-contact address.
 *
 * Claims travel as wire-mesh session frames (MeshTransport.broadcastCoordinatorClaim/sendCoordinatorClaim), and only over sessions to peers on this machine, because both duties the role assigns are facts about one machine: a PID probe can only see local processes and the cc-peer front can only reach local Claude Code sessions.
 *
 * When a claim is made: a store claims only when it knows of no incumbent and is the first on the machine as far as it can tell. A store that bound the well-known port with no first-contact presence configured can meet other stores only through that port, so it claims at once; one that may be reachable through first contact (it bound the port, or could neither join nor bind it) first waits one claim wait for an incumbent's announcement, so a store arriving at an existing mesh never takes the role at an equal term before the holder's claim reaches it. Both ends of every machine-local session announce the incumbent they know as the session is enrolled. When the incumbent departs, the lowest device-id among the peers this side has a machine-local session to claims at once at a raised term, and every other survivor claims too if, one claim wait later, the claim it accepts still names a holder it has no session to, which covers a lowest-id peer that is itself gone or was never reachable. A claim that is accepted always names a holder that is here, so the wait after an accepted claim never starts: the claim waits are the one after a departure and the one at start-up.
 *
 * Whose claims count: a claim is evaluated only when its holder is this side, the peer that sent it (the session's authenticated device-id, never a field of the frame), or a peer this side has a machine-local session to. A claim gossiped onward by a peer other than its holder is therefore still accepted wherever the holder is reachable, which is every peer of a fully connected machine. Any other claim, naming a holder that is not here, waits until that holder's session is enrolled and is dropped after one claim wait, so a claim for an absent device neither changes the incumbent nor starts a takeover. What waits is bounded by sender: each machine-local peer has at most PENDING_CLAIMS_PER_SENDER waiting claims, at most one per holder, kept in the election's own order (higher term first, an equal term by lowest holder id), so a peer that floods claims displaces only its own and never another peer's. A sender can still claim itself, or name a peer this side has a session to, at any term, so this narrows what a trusted machine-local peer can do, which is to name an absent holder; it does not stop that peer taking the role or forcing it onto a present peer, which signed claims would.
 */

import {
  CoordinatorElection,
  compareDeviceIds,
  type CoordinatorClaim,
} from "wire-mesh-core/domain/coordinator-election";
import {
  deviceIdFromHex,
  deviceIdToHex,
} from "wire-mesh-core/domain/device-id";
import type { CoordinatorFrame } from "wire-mesh-core/generated/protocol";
import type { ConnectionHandle, MeshTransport } from "./transport.js";

/** The longest delay setTimeout accepts: past it the timer fires at once, which would turn a long backoff into a burst of takeovers. */
const MAX_TIMER_MS = 0x7fff_ffff;

/** The claim this side currently accepts, in the hex form the rest of agent-comms addresses peers by. */
export interface CoordinatorClaimView {
  term: number;
  holder: string;
}

/** What CoordinatorRole needs from MeshStore. The transport's electionPeerIds, not MeshStore's peer list, decides which peers count as survivors and as reachable holders, because only a peer with a machine-local session can ever claim the role or hear this side's claims. */
export interface CoordinatorRoleDeps {
  getPeerId: () => string;
  requireTransport: () => Pick<
    MeshTransport,
    "broadcastCoordinatorClaim" | "sendCoordinatorClaim" | "electionPeerIds"
  >;
  /** How long this side waits for an incumbent's claim to reach it before claiming the role itself: after the incumbent departs, after accepting a claim whose holder it has no session to, and before a store that may not be alone claims a vacant role. MeshStore passes ROOM_REQUEST_TIMEOUT_MS, the ordinary bound on a frame reaching a connected peer, unless a test shortens it. */
  claimWaitMs: number;
  /** Starts the duties the role carries. Never runs concurrently with onLost. */
  onGained: () => Promise<void>;
  /** Stops the duties the role carries. Never runs concurrently with onGained. */
  onLost: () => Promise<void>;
  onError: (error: unknown) => void;
}

/** Orders waiting claims as the election ranks claims: a higher term first, and at an equal term the lower holder id, which is a device-id in lower-case hex of one length. */
function rankedFirst(left: PendingClaim, right: PendingClaim): number {
  if (left.frame.term !== right.frame.term) {
    return right.frame.term - left.frame.term;
  }
  if (left.holder === right.holder) return 0;
  return left.holder < right.holder ? -1 : 1;
}

function sameClaim(
  frame: Readonly<CoordinatorFrame>,
  claim: Readonly<CoordinatorClaim>,
): boolean {
  return (
    frame.term === claim.term &&
    compareDeviceIds(frame.coordinator, claim.coordinator) === 0
  );
}

/** How many claims one machine-local peer may have waiting for their holders to enrol, one per holder. */
const PENDING_CLAIMS_PER_SENDER = 4;

/** A claim set aside because its holder is neither this side, its sender nor a peer with a session here, with who sent it and the timer that drops it after one claim wait. */
interface PendingClaim {
  readonly handle: Readonly<ConnectionHandle>;
  readonly frame: Readonly<CoordinatorFrame>;
  readonly holder: string;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class CoordinatorRole {
  /** Built on first use rather than at construction, because MeshStore's peerId is assigned after its constructor runs (every bridge sets it to the identity's device-id). */
  private electionInstance: CoordinatorElection | undefined;
  /** Whether the duties are running here, or are being started; set as each transition begins, so onGained and onLost each fire exactly once per change of holder. */
  private holding = false;
  /** Every onGained and onLost, chained so each starts only once the previous one has finished: a role lost and regained in quick succession must not start the duties while they are still being stopped. */
  private transitions: Promise<void> = Promise.resolve();
  /** Set while this side waits out claimWaitMs for an incumbent it can reach. */
  private claimWait: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  /** Takeovers this side has made in a row on an unreachable incumbent. Each doubles the next claim wait, so roles that cannot all reach one holder raise the term ever more slowly instead of at every wait; accepting a claim whose holder this side can reach ends the run. */
  private takeoverStreak = 0;
  /** The claim, as `term:holder`, each peer was last answered with. A peer whose view lags keeps sending the claims it knows, and answering each one with the same incumbent only multiplies the traffic: the answer is repeated only when the incumbent changes or the peer's session is enrolled afresh, since the earlier answer may have been lost with the old session. */
  private readonly answered = new Map<string, string>();
  /** The claims set aside, by the device-id of the session that sent each, best first in the election's own order. */
  private readonly pending = new Map<string, PendingClaim[]>();

  constructor(private readonly deps: Readonly<CoordinatorRoleDeps>) {}

  private get election(): CoordinatorElection {
    this.electionInstance ??= new CoordinatorElection({
      ownDevice: deviceIdFromHex(this.deps.getPeerId()),
    });
    return this.electionInstance;
  }

  /** Whether this side holds the role now. */
  isHolder(): boolean {
    return this.holding;
  }

  /** The claim this side currently accepts, or undefined when it has neither made nor heard one. */
  current(): CoordinatorClaimView | undefined {
    const claim = this.electionInstance?.current();
    if (claim === undefined) return undefined;
    return { term: claim.term, holder: deviceIdToHex(claim.coordinator) };
  }

  /** Claims the role at once when this side knows of no incumbent at all. Called by a store that can meet no other store except through the well-known port it just bound; a no-op once any claim has been made or heard. */
  async claimIfVacant(): Promise<void> {
    if (this.stopped || this.election.current() !== undefined) return;
    await this.claim();
  }

  /** Claims the role one claim wait from now, unless by then this side has accepted a claim naming a holder it can reach. Called by a store that is alone as far as the well-known port tells it but may yet meet an incumbent through first contact, which gets that long to announce itself. */
  claimIfVacantAfterWait(): void {
    if (this.stopped || this.election.current() !== undefined) return;
    this.startClaimWait();
  }

  /** Tells a peer whose machine-local session was just enrolled which claim this side accepts, so a joiner learns the incumbent instead of claiming over it. A no-op while this side knows of none. */
  async announceTo(handle: Readonly<ConnectionHandle>): Promise<void> {
    this.answered.delete(handle.id);
    const frame = this.electionInstance?.announceCurrent();
    if (frame !== undefined) {
      await this.deps.requireTransport().sendCoordinatorClaim(handle, frame);
    }
    // The session just enrolled may be the holder claims were set aside for.
    for (const waiting of this.takePendingFor(handle.id)) {
      await this.handleClaim(waiting.handle, waiting.frame);
    }
  }

  /** Evaluates a claim a peer gossiped. An accepted claim is gossiped on to every peer so the supersession reaches peers the sender is not connected to, a claim whose holder is not here waits for that holder to enrol and is dropped after one claim wait; a stale or tiebreak-losing claim is answered with the incumbent so its sender converges, and a claim whose term no later claim could supersede is dropped unevaluated, neither gossiped nor answered. Receiving the incumbent itself is neither, and is dropped without a reply, which is what stops two peers that agree from echoing it forever. */
  async handleClaim(
    handle: Readonly<ConnectionHandle>,
    frame: Readonly<CoordinatorFrame>,
  ): Promise<void> {
    if (this.stopped) return;
    if (!this.holderIsHere(handle, frame)) {
      this.setAside(handle, frame);
      return;
    }
    const result = this.election.evaluate(frame);
    if (result.outcome === "accepted") {
      this.answered.clear();
      this.cancelClaimWait();
      // The holder of an accepted claim is here, so there is no incumbent to wait out.
      this.takeoverStreak = 0;
      await this.deps.requireTransport().broadcastCoordinatorClaim(frame);
    } else if (
      result.outcome === "retained" &&
      !sameClaim(frame, result.incumbent)
    ) {
      const incumbent = this.election.announceCurrent();
      const answer = `${String(result.incumbent.term)}:${deviceIdToHex(result.incumbent.coordinator)}`;
      if (incumbent !== undefined && this.answered.get(handle.id) !== answer) {
        this.answered.set(handle.id, answer);
        await this.deps
          .requireTransport()
          .sendCoordinatorClaim(handle, incumbent);
      }
    }
    await this.syncHolding();
  }

  /** Recovers the role when the departed peer held it. The lowest device-id among the peers this side has a machine-local session to claims at once at a raised term; every other survivor waits one claim wait and claims itself if the claim it then accepts still names a holder it has no session to, then runs onDelayedTakeover (the caller's single-authority announcement of the departed holder, which a delayed successor makes too). */
  async handleDeparture(
    peerId: string,
    onDelayedTakeover: () => Promise<void>,
  ): Promise<void> {
    if (this.stopped || this.current()?.holder !== peerId) return;
    if (this.isLowestSurvivor(peerId)) {
      await this.claim();
      return;
    }
    this.startClaimWait(onDelayedTakeover);
  }

  /** Stops taking part and gives the duties up if this side held them, once any transition still running has finished. Idempotent. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelClaimWait();
    this.dropAllPending();
    await this.syncHolding();
  }

  /** Whether the holder a claim names is this side, the peer that sent it, or a peer this side has a machine-local session to. The sender is the handle's authenticated device-id, so a peer cannot name itself as someone else. */
  private holderIsHere(
    handle: Readonly<ConnectionHandle>,
    frame: Readonly<CoordinatorFrame>,
  ): boolean {
    const holder = deviceIdToHex(frame.coordinator);
    return (
      holder === this.deps.getPeerId() ||
      holder === handle.id ||
      this.deps.requireTransport().electionPeerIds().has(holder)
    );
  }

  /** Keeps a claim whose holder is not here until that holder's session is enrolled, and drops it after one claim wait. The sender keeps at most PENDING_CLAIMS_PER_SENDER of them, one per holder, so a new claim for a holder already waiting replaces it only at a higher term, and when the sender is over its share the claim the election ranks last goes. */
  private setAside(
    handle: Readonly<ConnectionHandle>,
    frame: Readonly<CoordinatorFrame>,
  ): void {
    const holder = deviceIdToHex(frame.coordinator);
    const mine = this.pending.get(handle.id) ?? [];
    const same = mine.find((entry) => entry.holder === holder);
    if (same !== undefined) {
      if (same.frame.term >= frame.term) return;
      this.forget(handle.id, same);
    }
    const timer = setTimeout(() => {
      const waiting = (this.pending.get(handle.id) ?? []).find(
        (entry) => entry.holder === holder && entry.frame === frame,
      );
      if (waiting !== undefined) this.forget(handle.id, waiting);
    }, this.deps.claimWaitMs);
    // Never what keeps a process alive: a store shutting down stops the role anyway.
    timer.unref();
    const kept = [
      ...(this.pending.get(handle.id) ?? []),
      { handle, frame, holder, timer },
    ].sort(rankedFirst);
    this.pending.set(handle.id, kept);
    for (const extra of kept.slice(PENDING_CLAIMS_PER_SENDER)) {
      this.forget(handle.id, extra);
    }
  }

  /** Removes one waiting claim and its timer. */
  private forget(sender: string, entry: PendingClaim): void {
    clearTimeout(entry.timer);
    const rest = (this.pending.get(sender) ?? []).filter(
      (other) => other !== entry,
    );
    if (rest.length === 0) this.pending.delete(sender);
    else this.pending.set(sender, rest);
  }

  /** Takes every waiting claim that names `holder`, whoever sent it, best first. */
  private takePendingFor(holder: string): PendingClaim[] {
    const taken: PendingClaim[] = [];
    for (const [sender, entries] of [...this.pending]) {
      for (const entry of entries) {
        if (entry.holder !== holder) continue;
        this.forget(sender, entry);
        taken.push(entry);
      }
    }
    return taken.sort(rankedFirst);
  }

  private dropAllPending(): void {
    for (const [sender, entries] of [...this.pending]) {
      for (const entry of entries) this.forget(sender, entry);
    }
  }

  private isLowestSurvivor(departedPeerId: string): boolean {
    const selfId = this.deps.getPeerId();
    const self = deviceIdFromHex(selfId);
    for (const id of this.deps.requireTransport().electionPeerIds()) {
      if (id === departedPeerId || id === selfId) continue;
      if (compareDeviceIds(deviceIdFromHex(id), self) < 0) return false;
    }
    return true;
  }

  /** Whether the claim this side accepts leaves the role without a holder it can reach: there is no claim at all, or it names a device that is neither this side nor a peer this side has a machine-local session to. */
  private incumbentUnreachable(): boolean {
    const claim = this.current();
    if (claim === undefined) return true;
    if (claim.holder === this.deps.getPeerId()) return false;
    return !this.deps.requireTransport().electionPeerIds().has(claim.holder);
  }

  /** Waits one claim wait, then claims at a raised term and runs onTakeover (when given) if the incumbent is still unreachable. Replaces any wait already running, since only the latest accepted claim decides whether a takeover is due. */
  private startClaimWait(onTakeover?: () => Promise<void>): void {
    this.cancelClaimWait();
    const wait = Math.min(
      this.deps.claimWaitMs * 2 ** this.takeoverStreak,
      MAX_TIMER_MS,
    );
    this.claimWait = setTimeout(() => {
      this.claimWait = undefined;
      if (this.stopped || !this.incumbentUnreachable()) return;
      this.takeoverStreak += 1;
      void this.claim()
        .then(async () => onTakeover?.())
        .catch(this.deps.onError);
    }, wait);
    // Never what keeps a process alive: a store shutting down stops the role anyway.
    this.claimWait.unref();
  }

  private async claim(): Promise<void> {
    const frame = this.election.claim();
    await this.deps.requireTransport().broadcastCoordinatorClaim(frame);
    await this.syncHolding();
  }

  private cancelClaimWait(): void {
    if (this.claimWait === undefined) return;
    clearTimeout(this.claimWait);
    this.claimWait = undefined;
  }

  /** Queues a transition to whatever holding should now be. Resolves once that transition has run, and rejects with its failure; the chain itself carries on past a failure, which reaches this call's caller instead. */
  private async syncHolding(): Promise<void> {
    const next = this.transitions.then(async () => this.applyHolding());
    this.transitions = next.catch(() => undefined);
    await next;
  }

  /** Starts or stops the duties when the incumbent changed to or from this side since the previous transition. Reads the election afresh when the transition actually runs, not when it was queued, so a claim evaluated while an earlier transition was still running is reflected exactly once. */
  private async applyHolding(): Promise<void> {
    const holds = !this.stopped && this.electionInstance?.isSelf() === true;
    if (holds === this.holding) return;
    this.holding = holds;
    await (holds ? this.deps.onGained() : this.deps.onLost());
  }
}

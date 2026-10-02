/**
 * CoordinatorRole: the elected holder of this machine's coordinator duties (agent-comms#341), the stale-agent PID probe, single-authority departure announcements, and the default cc-peer front. Held by gossiped, term-based claim (wire-mesh-core's CoordinatorElection over the spec's coordinator-frame) rather than by whoever binds the well-known port: a higher term always supersedes a lower one, an equal term breaks by lowest device-id, and any live peer can take the role over by raising the term, so a peer that never bound the port can hold it and the port stays only a compatibility first-contact address.
 *
 * Claims travel as wire-mesh session frames (MeshTransport.broadcastCoordinatorClaim/sendCoordinatorClaim), and only over sessions to peers on this machine, because both duties the role assigns are facts about one machine: a PID probe can only see local processes and the cc-peer front can only reach local Claude Code sessions.
 *
 * When a claim is made: a store claims only when it knows of no incumbent and is the first on the machine as far as it can tell. A store that bound the well-known port with no first-contact presence configured can meet other stores only through that port, so it claims at once; one that may be reachable through first contact (it bound the port, or could neither join nor bind it) first waits one claim wait for an incumbent's announcement, so a store arriving at an existing mesh never takes the role at an equal term before the holder's claim reaches it. Both ends of every machine-local session announce the incumbent they know as the session is enrolled. When the incumbent departs, the lowest device-id among the peers this side has a machine-local session to claims at once at a raised term, and every other survivor claims too if, one claim wait later, the claim it accepts still names a holder it has no session to, which covers a lowest-id peer that is itself gone or was never reachable. The same wait follows accepting a claim whose holder this side has no session to, so a claim naming a device that never joined cannot pin the role vacant.
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

function sameClaim(
  frame: Readonly<CoordinatorFrame>,
  claim: Readonly<CoordinatorClaim>,
): boolean {
  return (
    frame.term === claim.term &&
    compareDeviceIds(frame.coordinator, claim.coordinator) === 0
  );
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
    const frame = this.electionInstance?.announceCurrent();
    if (frame === undefined) return;
    await this.deps.requireTransport().sendCoordinatorClaim(handle, frame);
  }

  /** Evaluates a claim a peer gossiped. An accepted claim is gossiped on to every peer so the supersession reaches peers the sender is not connected to, and when it names a holder this side has no session to, this side waits one claim wait for that holder to appear before claiming over it; a stale or tiebreak-losing claim is answered with the incumbent so its sender converges, and a claim whose term no later claim could supersede is dropped unevaluated, neither gossiped nor answered. Receiving the incumbent itself is neither, and is dropped without a reply, which is what stops two peers that agree from echoing it forever. */
  async handleClaim(
    handle: Readonly<ConnectionHandle>,
    frame: Readonly<CoordinatorFrame>,
  ): Promise<void> {
    if (this.stopped) return;
    const result = this.election.evaluate(frame);
    if (result.outcome === "accepted") {
      this.cancelClaimWait();
      if (this.incumbentUnreachable()) this.startClaimWait();
      await this.deps.requireTransport().broadcastCoordinatorClaim(frame);
    } else if (
      result.outcome === "retained" &&
      !sameClaim(frame, result.incumbent)
    ) {
      const incumbent = this.election.announceCurrent();
      if (incumbent !== undefined) {
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
    await this.syncHolding();
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
    this.claimWait = setTimeout(() => {
      this.claimWait = undefined;
      if (this.stopped || !this.incumbentUnreachable()) return;
      void this.claim()
        .then(async () => onTakeover?.())
        .catch(this.deps.onError);
    }, this.deps.claimWaitMs);
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

/**
 * CoordinatorRole: the elected holder of this machine's coordinator duties (agent-comms#341), the stale-agent PID probe, single-authority departure announcements, and the default cc-peer front. Held by gossiped, term-based claim (wire-mesh-core's CoordinatorElection over the spec's coordinator-frame) rather than by whoever binds the well-known port: a higher term always supersedes a lower one, an equal term breaks by lowest device-id, and any live peer can take the role over by raising the term, so a peer that never bound the port can hold it and the port stays only a compatibility first-contact address.
 *
 * Claims travel as wire-mesh session frames (MeshTransport.broadcastCoordinatorClaim/sendCoordinatorClaim), and only over sessions to peers on this machine, because both duties the role assigns are facts about one machine: a PID probe can only see local processes and the cc-peer front can only reach local Claude Code sessions.
 *
 * When a claim is made: a store claims only when it knows of no incumbent and is the first on the machine as far as it can tell (it bound the well-known port, or could neither join nor bind it), so a store that joined an existing mesh never steals the role at an equal term before the holder's announcement reaches it; every store announces the incumbent it knows over each session the moment it opens. When the incumbent departs, the lowest device-id among the peers this side still knows claims at once at a raised term, and every other survivor claims too if no claim above the departed holder's term has reached it within the ordinary network deadline, which covers a lowest-id peer that is itself gone or was never reachable.
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
import { ROOM_REQUEST_TIMEOUT_MS } from "./request-timeouts.js";
import type { ConnectionHandle, MeshTransport } from "./transport.js";

/** The claim this side currently accepts, in the hex form the rest of agent-comms addresses peers by. */
export interface CoordinatorClaimView {
  term: number;
  holder: string;
}

/** What CoordinatorRole needs from MeshStore. livePeerIds is every peer this side currently counts as present, its own id included (MeshStore's peerInfo keys); onGained/onLost start and stop the duties the role carries. */
export interface CoordinatorRoleDeps {
  getPeerId: () => string;
  livePeerIds: () => Iterable<string>;
  requireTransport: () => Pick<
    MeshTransport,
    "broadcastCoordinatorClaim" | "sendCoordinatorClaim"
  >;
  onGained: () => Promise<void>;
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
  /** Whether the duties are currently running here, so onGained and onLost each fire exactly once per change of holder. */
  private holding = false;
  /** Set while this side waits out ROOM_REQUEST_TIMEOUT_MS after the incumbent departed. */
  private successorWait: ReturnType<typeof setTimeout> | undefined;
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

  /** Claims the role when this side knows of no incumbent at all. Called by a store that is first on its machine as far as it can tell; a no-op once any claim has been made or heard. */
  async claimIfVacant(): Promise<void> {
    if (this.stopped || this.election.current() !== undefined) return;
    await this.claim();
  }

  /** Tells a peer whose session just opened which claim this side accepts, so a joiner learns the incumbent instead of claiming over it. A no-op while this side knows of none. */
  async announceTo(handle: Readonly<ConnectionHandle>): Promise<void> {
    const frame = this.electionInstance?.announceCurrent();
    if (frame === undefined) return;
    await this.deps.requireTransport().sendCoordinatorClaim(handle, frame);
  }

  /** Evaluates a claim a peer gossiped. An accepted claim is gossiped on to every peer so the supersession reaches peers the sender is not connected to; a stale or tiebreak-losing claim is answered with the incumbent so its sender converges. Receiving the incumbent itself is neither, and is dropped without a reply, which is what stops two peers that agree from echoing it forever. */
  async handleClaim(
    handle: Readonly<ConnectionHandle>,
    frame: Readonly<CoordinatorFrame>,
  ): Promise<void> {
    if (this.stopped) return;
    const result = this.election.evaluate(frame);
    if (result.outcome === "accepted") {
      this.cancelSuccessorWait();
      await this.deps.requireTransport().broadcastCoordinatorClaim(frame);
    } else if (!sameClaim(frame, result.incumbent)) {
      const incumbent = this.election.announceCurrent();
      if (incumbent !== undefined) {
        await this.deps
          .requireTransport()
          .sendCoordinatorClaim(handle, incumbent);
      }
    }
    await this.syncHolding();
  }

  /** Recovers the role when the departed peer held it. The lowest device-id among the peers this side still counts as present claims at once at a raised term; every other survivor waits ROOM_REQUEST_TIMEOUT_MS (the ordinary bound on a frame reaching a connected peer, so by then a live successor's claim would have arrived) for a claim above the departed holder's term and claims itself if none came, then runs onDelayedTakeover (the caller's single-authority announcement of the departed holder, which a delayed successor makes too). */
  async handleDeparture(
    peerId: string,
    onDelayedTakeover: () => Promise<void>,
  ): Promise<void> {
    const incumbent = this.current();
    if (this.stopped || incumbent?.holder !== peerId) return;
    if (this.isLowestSurvivor(peerId)) {
      await this.claim();
      return;
    }
    this.cancelSuccessorWait();
    const departedTerm = incumbent.term;
    this.successorWait = setTimeout(() => {
      this.successorWait = undefined;
      const now = this.election.current();
      if (now !== undefined && now.term > departedTerm) return;
      void this.claim().then(onDelayedTakeover).catch(this.deps.onError);
    }, ROOM_REQUEST_TIMEOUT_MS);
    // Never what keeps a process alive: a store shutting down stops the role anyway.
    this.successorWait.unref();
  }

  /** Stops taking part and gives the duties up if this side held them. Idempotent. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelSuccessorWait();
    if (!this.holding) return;
    this.holding = false;
    await this.deps.onLost();
  }

  private isLowestSurvivor(departedPeerId: string): boolean {
    const selfId = this.deps.getPeerId();
    const self = deviceIdFromHex(selfId);
    for (const id of this.deps.livePeerIds()) {
      if (id === departedPeerId || id === selfId) continue;
      if (compareDeviceIds(deviceIdFromHex(id), self) < 0) return false;
    }
    return true;
  }

  private async claim(): Promise<void> {
    const frame = this.election.claim();
    await this.deps.requireTransport().broadcastCoordinatorClaim(frame);
    await this.syncHolding();
  }

  private cancelSuccessorWait(): void {
    if (this.successorWait === undefined) return;
    clearTimeout(this.successorWait);
    this.successorWait = undefined;
  }

  /** Starts or stops the duties when the incumbent changed to or from this side. holding is updated before awaiting, so a claim evaluated while onGained is still running cannot fire it twice. */
  private async syncHolding(): Promise<void> {
    const isSelf = this.election.isSelf();
    if (isSelf === this.holding) return;
    this.holding = isSelf;
    await (isSelf ? this.deps.onGained() : this.deps.onLost());
  }
}

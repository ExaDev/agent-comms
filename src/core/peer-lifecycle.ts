/**
 * PeerLifecycle: the TransportEvents callbacks around a peer's own comings and goings on the mesh: peer-list/peer-joined bookkeeping, the well-known port holder's new-peer introduction handshake, post-connection state-sync, claiming the elected coordinator role when this store is alone, inbound data-message routing (state_sync/state_update), taking over the well-known port listener, and peer disconnection. Split out of mesh-store.ts to reduce it under the repo's max-lines cap.
 *
 * Two roles are kept apart here (agent-comms#341). The well-known port listener is only the compatibility first-contact address and introduction path, and is still passed on by graceful handover and recovered by the bind race. The coordinator duties (the stale-agent probe, single-authority departure announcements, the default cc-peer front) follow the elected CoordinatorRole instead, whose holder need not be the peer that bound the port.
 */

import { reportRejection } from "./detached-work.js";
import { DeferredIntake } from "./deferred-intake.js";
import type { KnownAgents } from "./known-agents.js";
import {
  AgentSlots,
  admitPatch,
  admitSnapshot,
  isAwaitingAuthority,
  type StateSender,
} from "./state-intake.js";
import { normaliseWireState } from "./wire-protocol.js";
import { parseIsoTimestampMs } from "./iso-timestamp.js";
import type {
  MeshMessage,
  PeerInfo,
  SerialisedState,
} from "./wire-protocol.js";
import {
  BECOME_COORDINATOR_BIND_RETRIES,
  BECOME_COORDINATOR_BIND_RETRY_DELAY_MS,
  isAddrInUse,
  isConnectionRefused,
} from "./bind-retry.js";
import { ROOM_REQUEST_TIMEOUT_MS } from "./request-timeouts.js";
import { COORDINATOR_HOST } from "./mesh-store-shared.js";
import { startFirstContact, type FirstContact } from "./first-contact.js";
import type { DeliveryEngine } from "./delivery-engine.js";
import type { StaleAgentChecker } from "./stale-agent-checker.js";
import type { RoomProtocol } from "./room-protocol.js";
import type { CoordinatorRole } from "./coordinator-role.js";
import type { ConnectionHandle, MeshTransport } from "./transport.js";

/** The state and collaborators PeerLifecycle needs from MeshStore. peerInfo/agents are direct references into MeshStore's own fields; coordinatorPort is a readonly value copied once; serialise is MeshStore's own retained method (constraint: it must stay directly on MeshStore.prototype, so PeerLifecycle calls it through this closure rather than owning it); roomProtocol/deliveryEngine/staleAgentChecker are the already-constructed instances (construction order: ... -\> roomProtocol -\> ... -\> staleAgentChecker -\> peerLifecycle), narrowed to what peer-lifecycle bookkeeping ever needs. */
export interface PeerLifecycleDeps {
  peerInfo: Map<string, PeerInfo>;
  agents: KnownAgents;
  coordinatorPort: number;
  /** The UDP port the coordinator-free first-contact presence binds (agent-comms#341). Undefined means no presence at all: only the bridge entry points set it (bridge-mesh.ts), so a store built by anything else, a test included, never cross-discovers another store. */
  firstContactPort?: number | undefined;
  /** Receives every web UI beacon the presence hears (agent-comms#353). Absent when the caller wants none. */
  onWebBeacon?: (
    beacon: Readonly<{ peerId: string; host: string; webPort: number }>,
  ) => void;
  getPeerId: () => string;
  /** The peer ID of the coordinator this side currently answers to, as the transport reports it -- undefined when this side is the coordinator itself or has never reached one. Supplied as its own dep rather than read off requireTransport() so the crash-race decision below is expressible against a plain value in tests. */
  getCoordinatorPeerId: () => string | undefined;
  /** Forgets everything the store holds for an agent whose record it evicts to make room. */
  staleAgentChecker: Pick<StaleAgentChecker, "forget">;
  requireTransport: () => MeshTransport;
  serialise: () => SerialisedState;
  roomProtocol: Pick<RoomProtocol, "flushPendingRoomRequests">;
  deliveryEngine: Pick<
    DeliveryEngine,
    | "applyStateSync"
    | "applyPatch"
    | "notifyRoomsOfStatus"
    | "broadcastPatch"
    | "bump"
  >;
  /** The elected coordinator role: claimed when this side takes the port listener, or finds it held by something that never answers, with no incumbent known; recovered when its holder departs; and the authority retireDepartedAgent checks. Announcing it to each new session is the transport's onElectionSessionEnrolled, not a PeerLifecycle concern. */
  coordinatorRole: Pick<
    CoordinatorRole,
    | "claimIfVacant"
    | "claimIfVacantAfterWait"
    | "handleDeparture"
    | "isHolder"
    | "current"
    | "onHolderAccepted"
  >;
  /** The current time in milliseconds; absent means the system clock. */
  now?: (() => number) | undefined;
  /** Reports a failed takeover or rejoin. The crash-race path runs detached from any caller that could handle a rejection, so this is the only signal that a coordinator loss was noticed but not recovered from. */
  onError?: ((error: Error) => void) | undefined;
}

/** How many peers a refusal has been reported for, at most, before the record starts again: a report is made once per peer, so a flood of peers cannot flood the error channel or this set. */
const MAX_REPORTED_PEERS = 1024;

/** How much of a peer's id a report names: enough to tell peers apart in a log. */
const SHORT_ID_LENGTH = 12;

/** The message an unknown thrown value is reported as, so a takeover or rejoin failure reads the same whether the transport rejected with an Error or something else. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** How many times a peer that has lost its coordinator alternates between binding the vacated port and joining whoever bound it first. A round that loses the bind has already spent a full becomeCoordinator retry window (BECOME_COORDINATOR_BIND_RETRIES attempts, BECOME_COORDINATOR_BIND_RETRY_DELAY_MS apart), so the rounds together are bounded by ROOM_REQUEST_TIMEOUT_MS, the ordinary bound on a peer completing a step. Several rounds are genuinely needed because the departed holder's own listener can outlast the sessions that reported its departure: its close only finishes once its transport has closed every session, which under load takes far longer than one retry window, and every bind and dial in that interval meets the dying listener. */
const COORDINATOR_TAKEOVER_ROUNDS = Math.ceil(
  ROOM_REQUEST_TIMEOUT_MS /
    (BECOME_COORDINATOR_BIND_RETRIES * BECOME_COORDINATOR_BIND_RETRY_DELAY_MS),
);

/** What one attempt to join whoever won the bind race concluded. "unsettled" means no successor holds the port yet, so the caller re-enters the bind race: nothing was listening (the port was taken when this side tried to bind it and free again by the time it tried to dial), the dial reached the lost holder's own listener while it was still closing (told apart by the device-id the dial authenticated), or the dial failed on a connection that was torn down mid-handshake, which says the same thing. `cause` is the dial failure, when there was one, so that giving up can say what the last attempt met. */
type RejoinOutcome =
  { outcome: "joined" } | { outcome: "unsettled"; cause?: Error };

export class PeerLifecycle {
  private readonly slots: AgentSlots;

  /** The peers a refusal has been reported for. */
  private readonly reportedPeers = new Set<string>();

  /** What a sender gave before the claim that makes it the coordinator was accepted, applied when that claim is. */
  private readonly deferred: DeferredIntake;

  /** Guards against a second contest running while the first is still binding or rejoining -- a coordinator whose process dies can close more than one session to this side, and each close arrives as its own disconnect. */
  private contestingCoordinatorRole = false;

  /** The first-contact presence, when one was configured and started; owned here because discovering a peer and dialling it is peer-lifecycle bookkeeping (handlePeerList), the same path a coordinator's peer_list takes. */
  private firstContact: FirstContact | undefined;

  constructor(private readonly deps: PeerLifecycleDeps) {
    deps.coordinatorRole.onHolderAccepted = (holderId) => {
      this.handleHolderAccepted(holderId);
    };
    this.slots = new AgentSlots({
      agents: deps.agents,
      forget: (agentId) => {
        deps.staleAgentChecker.forget(agentId);
      },
      ownId: () => deps.getPeerId(),
    });
    this.deferred = new DeferredIntake(
      deps.now ?? Date.now,
      ROOM_REQUEST_TIMEOUT_MS,
      (agentId) => deps.agents.get(agentId)?.version,
    );
  }

  /** Starts the coordinator-free presence (agent-comms#341) when a firstContactPort was configured: each discovered peer (carrying the host its beacon came from) is fed through handlePeerList, whose dial-out plus the peer_list every established connection shares (handlePeerConnected) forms the mesh transitively with no coordinator's handout. A no-op with no port, and on a second call. */
  startFirstContact(): void {
    const port = this.deps.firstContactPort;
    if (port === undefined || this.firstContact !== undefined) return;
    this.firstContact = startFirstContact({
      peerId: this.deps.getPeerId(),
      dataPort: this.deps.requireTransport().dataPort,
      port,
      onWebBeacon: this.deps.onWebBeacon,
      onPeer: (info) => {
        this.handlePeerList([info]);
      },
      onError: (error) => {
        this.deps.onError?.(error);
      },
    });
  }

  /** Stops the presence and releases its port. Idempotent, and a no-op when none was started. */
  stopFirstContact(): void {
    this.firstContact?.stop();
    this.firstContact = undefined;
  }

  /**
   * init()'s single attempt at the well-known port: connect to whoever holds it, or bind it through the same takeover a handover or crash race runs (which, knowing of no elected incumbent, claims the coordinator role as the first store on this machine as far as it can tell). If the port is occupied but unresponsive (e.g. an orphan process from a previous session), carry on without it instead of retrying: first contact still forms the mesh, and with nothing answering on the port this store claims the coordinator role the same way, unless first contact brings it an incumbent's claim first. Retrying tls.connect after a failed handshake to a non-TLS endpoint can freeze the event loop (Node.js TLS session cache bug), so this only tries once. A bind failure other than EADDRINUSE is rethrown.
   */
  async joinWellKnownPort(): Promise<void> {
    const transport = this.deps.requireTransport();
    const port = this.deps.coordinatorPort;
    try {
      await transport.connectToCoordinator(
        COORDINATOR_HOST,
        port,
        this.deps.getPeerId(),
        transport.dataPort,
      );
      return;
    } catch {
      // Nothing reachable answered as the port holder; fall through to binding it.
    }
    try {
      await this.handleBecomeCoordinator([]);
      return;
    } catch (error) {
      if (!isAddrInUse(error)) throw error;
      // connectToCoordinator already failed above, so whatever holds this port never answered as a reachable coordinator either. Name the actual mismatch rather than a generic "unavailable".
      this.deps.onError?.(
        new Error(
          `MeshStore: could not join or create a mesh on port ${String(port)}. ` +
            `port ${String(port)} is already in use by something that never answered as a reachable coordinator: a stale process from a previous run, or an incompatible agent-comms version. ` +
            "agent-comms will reach other peers through first contact only until this is resolved. " +
            `(${describe(error)})`,
        ),
      );
    }
    await this.claimWhileAlone();
  }

  /** Claims the elected role for a store that knows of no incumbent and met nobody on the well-known port. With no first-contact presence configured, the port is the only way another store could reach this one, so it claims at once. With one, an incumbent that never held the port may still be about to announce itself over a first-contact session, so the claim waits for it rather than taking the role at an equal term and winning the tiebreak against a holder that was there first. */
  private async claimWhileAlone(): Promise<void> {
    if (this.deps.firstContactPort === undefined) {
      await this.deps.coordinatorRole.claimIfVacant();
      return;
    }
    this.deps.coordinatorRole.claimIfVacantAfterWait();
  }

  handlePeerList(peers: readonly PeerInfo[]): void {
    const peerId = this.deps.getPeerId();
    for (const peer of peers) {
      this.deps.peerInfo.set(peer.id, peer);
      // The list always includes this store's own entry — dialling yourself is a wasted connection attempt (and, on some platforms, an immediate self-inflicted ECONNRESET) that never needs to happen.
      if (peer.id === peerId) continue;
      this.detach(this.deps.requireTransport().connectToPeer(peer, peerId));
    }
  }

  handlePeerJoined(peer: Readonly<PeerInfo>): void {
    this.deps.peerInfo.set(peer.id, peer);
    const peerId = this.deps.getPeerId();
    if (peer.id === peerId) return;
    this.detach(this.deps.requireTransport().connectToPeer(peer, peerId));
  }

  async handleIntroduction(
    handle: Readonly<ConnectionHandle>,
    msg: Readonly<{ peerId: string; dataPort: number }>,
  ): Promise<void> {
    const newPeer: PeerInfo = {
      id: msg.peerId,
      port: msg.dataPort,
      startedAt: new Date().toISOString(),
    };
    this.deps.peerInfo.set(msg.peerId, newPeer);

    // Send full peer list to the new peer
    const peerList: MeshMessage = {
      method: "peer_list",
      peers: [...this.deps.peerInfo.values()],
    };
    await this.deps.requireTransport().send(handle, peerList);

    // Broadcast arrival to all existing peers
    const joined: MeshMessage = { method: "peer_joined", peer: newPeer };
    await this.deps.requireTransport().broadcast(joined);

    // Connect to the new peer's data server
    void this.deps
      .requireTransport()
      .connectToPeer(newPeer, this.deps.getPeerId());
  }

  /** The snapshot this side gives a peer that connected. An agent is described by its own store or the coordinator, so a side that is neither the coordinator nor holding its role gives only its own agent: whatever else it holds, the peer is refused it, and the owners give theirs themselves. */
  private stateToShare(): SerialisedState {
    const state = this.deps.serialise();
    if (
      this.deps.requireTransport().isCoordinator ||
      this.deps.coordinatorRole.isHolder()
    ) {
      return state;
    }
    const own = state.agents[this.deps.getPeerId()];
    return { ...state, agents: own === undefined ? {} : { [own.id]: own } };
  }

  async handlePeerConnected(
    handle: Readonly<ConnectionHandle>,
    _info: Readonly<PeerInfo>,
  ): Promise<void> {
    // If we have state and the peer doesn't, send state sync
    if (this.deps.agents.size > 0) {
      const state = this.stateToShare();
      await this.deps.requireTransport().send(handle, {
        method: "state_sync",
        state,
      });
    }
    // Share this side's known peers over every established connection (agent-comms#341): the receiver's handlePeerList dials each one it does not yet know, and each of those connections shares in turn, so the data-connection graph forms transitively by flooding and needs no coordinator's peer-list handout. Previously only a coordinator's introduce flow ever sent peer_list.
    const peerList: MeshMessage = {
      method: "peer_list",
      peers: [...this.deps.peerInfo.values()],
    };
    await this.deps.requireTransport().send(handle, peerList);
    await this.deps.roomProtocol.flushPendingRoomRequests(handle.id);
  }

  async handleDataMessage(
    handle: Readonly<ConnectionHandle>,
    msg: MeshMessage,
  ): Promise<void> {
    const sender: StateSender = {
      id: handle.id,
      isCoordinator:
        handle.id === this.deps.getCoordinatorPeerId() ||
        this.deps.coordinatorRole.current()?.holder === handle.id,
    };
    const ownId = this.deps.getPeerId();
    const claims = this.slots.open(this.originOf(handle.id));
    if (msg.method === "state_sync") {
      const { value, refused, awaitingAuthority } = admitSnapshot(
        normaliseWireState(msg.state),
        sender,
        ownId,
        claims,
      );
      for (const agent of awaitingAuthority) {
        this.deferred.holdAgent(handle.id, agent);
      }
      this.reportRefused(handle.id, refused);
      this.deps.deliveryEngine.applyStateSync(value);
    } else if (msg.method === "state_update") {
      if (!admitPatch(msg.patch, sender, ownId, claims)) {
        // What the coordinator sends can be read before the claim that names it is accepted, over another queue of the same session: what is refused only for want of that authority waits for the claim instead of being lost.
        if (isAwaitingAuthority(msg.patch, sender)) {
          if (msg.patch.type === "agent_upsert") {
            this.deferred.holdAgent(handle.id, msg.patch.agent);
          } else if (msg.patch.type === "agent_offline") {
            this.deferred.holdDeparture(handle.id, msg.patch.agentId);
          }
        }
        this.reportRefused(handle.id, 1);
        return;
      }
      await this.deps.deliveryEngine.applyPatch(msg.patch);
    }
  }

  /** Where a peer's agents are counted from: the host it was reached at, this machine for a peer reached on it, and the peer itself when this side has no entry for it. A host that presents many device keys is one origin. */
  private originOf(peerId: string): string {
    const info = this.deps.peerInfo.get(peerId);
    if (info === undefined) return `peer:${peerId}`;
    return info.host === undefined ? "machine" : `host:${info.host}`;
  }

  /** Applies what `holderId` gave before it was accepted as the holder, now that it is. Detached: it runs from the election's acceptance of a claim. */
  handleHolderAccepted(holderId: string): void {
    const released = this.deferred.release(holderId);
    if (released.agents.length === 0 && released.departures.length === 0) {
      return;
    }
    const sender: StateSender = { id: holderId, isCoordinator: true };
    const records = admitSnapshot(
      {
        agents: Object.fromEntries(released.agents.map((a) => [a.id, a])),
        rooms: {},
        messages: {},
        dms: {},
        deliveryQueues: {},
      },
      sender,
      this.deps.getPeerId(),
      this.slots.open(this.originOf(holderId)),
    );
    this.deps.deliveryEngine.applyStateSync(records.value);
    this.detach(
      Promise.all(
        released.departures.map(async (agentId) =>
          this.deps.deliveryEngine.applyPatch({
            type: "agent_offline",
            agentId,
          }),
        ),
      ),
    );
  }

  /** Forgets what is kept for a connection that ended. */
  private forgetSource(peerId: string): void {
    this.slots.release(this.originOf(peerId));
    this.deferred.drop(peerId);
    this.reportedPeers.delete(peerId);
  }

  /** Reports records of a peer's state that were refused, by count and once per peer: what a peer sent is not repeated, since it is the peer's to choose, and a peer that keeps sending them cannot flood the error channel. */
  private reportRefused(peerId: string, refused: number): void {
    if (refused === 0 || this.reportedPeers.has(peerId)) return;
    if (this.reportedPeers.size >= MAX_REPORTED_PEERS)
      this.reportedPeers.clear();
    this.reportedPeers.add(peerId);
    this.deps.onError?.(
      new Error(
        `PeerLifecycle: refused ${String(refused)} record(s) of state from peer ${peerId.slice(0, SHORT_ID_LENGTH)}: an agent is described by its own store or the coordinator, and a snapshot is bounded`,
      ),
    );
  }

  /** Takes over the well-known port listener (a fresh bind in init, a graceful handover, or winning the crash race) and dials the peers named. Holding the port no longer carries the coordinator duties; the one link left is that a port holder which knows of no elected incumbent claims the role, since it is then the first on its machine as far as it can tell. */
  async handleBecomeCoordinator(peerList: readonly PeerInfo[]): Promise<void> {
    // Take over as coordinator using the data server we already have
    await this.deps
      .requireTransport()
      .becomeCoordinator(COORDINATOR_HOST, this.deps.coordinatorPort);
    const peerId = this.deps.getPeerId();
    // peerList never names the successor itself (neither the graceful handover nor the crash race includes it), so this side's own entry is carried across the reset rather than dropped: handleIntroduction answers every later joiner with exactly these entries, and a joiner that is never told the coordinator's own data port never dials it.
    const self = this.deps.peerInfo.get(peerId);
    this.deps.peerInfo.clear();
    if (self !== undefined) this.deps.peerInfo.set(peerId, self);
    for (const peer of peerList) {
      this.deps.peerInfo.set(peer.id, peer);
      this.detach(this.deps.requireTransport().connectToPeer(peer, peerId));
    }
    await this.claimWhileAlone();
  }

  /** Work started for a peer and not awaited: a failure is reported through onError (or stderr), never left as an unhandled rejection. */
  private detach(work: Readonly<Promise<unknown>>): void {
    reportRejection(work, () => this.deps.onError);
  }

  handlePeerDisconnected(handle: Readonly<ConnectionHandle>): void {
    this.detach(this.handlePeerDeparture(handle.id));
  }

  /** Forgets a peer that could not be reached, if the entry still names the one that was dialled: a slow failed dial to an old address must not remove an entry refreshed in the meantime. The peer was never connected, so there is no agent to retire and no session to close: only the entry that would have it dialled again and offered to every new peer. */
  handlePeerUnreachable(peer: Readonly<PeerInfo>): void {
    if (this.deps.peerInfo.get(peer.id) === peer) {
      this.deps.peerInfo.delete(peer.id);
    }
  }

  /** The awaitable form of handlePeerDisconnected, which TransportEvents forces to be synchronous. A departing peer leaves the peer list. When it held the elected coordinator role, the role is recovered first (the lowest surviving device-id claims at a raised term), so the new holder is already in place by the time the departed peer's agent record is retired; when it held the well-known port this side dialled, the vacated port is contested too. */
  async handlePeerDeparture(peerId: string): Promise<void> {
    this.forgetSource(peerId);
    this.deps.peerInfo.delete(peerId);
    await this.deps.coordinatorRole.handleDeparture(peerId, async () =>
      this.retireDepartedAgent(peerId),
    );
    if (peerId === this.deps.getCoordinatorPeerId()) {
      await this.contestCoordinatorRole(peerId);
    }
    await this.retireDepartedAgent(peerId);
  }

  /** Races every other surviving peer to rebind the well-known port, which is what keeps the compatibility first-contact address answering after its holder CRASHES: unlike the graceful handover, a killed holder names no successor, so each survivor contests independently and the operating system's own exclusive bind decides the single winner. The winner runs the ordinary takeover path (handleBecomeCoordinator) over the peers it still holds connections to; a loser (the one case where the bind fails specifically because the port is already taken) re-introduces itself to the winner so it is a full member of the new mesh again, with its own data port known to whoever joins next. Direct peer-to-peer data connections are untouched throughout, so traffic between survivors never depends on the outcome of this race. */
  private async contestCoordinatorRole(
    lostCoordinatorId: string,
  ): Promise<void> {
    const transport = this.deps.requireTransport();
    if (transport.isCoordinator || this.contestingCoordinatorRole) return;
    this.contestingCoordinatorRole = true;
    try {
      const selfId = this.deps.getPeerId();
      const survivors = [...this.deps.peerInfo.values()].filter(
        (peer) => peer.id !== selfId && peer.id !== lostCoordinatorId,
      );
      let lastDialFailure: Error | undefined;
      for (let round = 0; round < COORDINATOR_TAKEOVER_ROUNDS; round++) {
        try {
          await this.handleBecomeCoordinator(survivors);
          return;
        } catch (error) {
          if (!isAddrInUse(error)) {
            this.deps.onError?.(
              new Error(
                `PeerLifecycle: could not take over the vacated coordinator port: ${describe(error)}`,
              ),
            );
            return;
          }
        }
        // A graceful handover racing this crash race can have made this side the coordinator while the bind above was in flight: the bind then fails against this side's own freshly bound listener, and dialling it would be this peer introducing itself to itself. Re-read through requireTransport() rather than the narrowed local, which TypeScript still believes is false from the guard at the top of this method.
        if (this.deps.requireTransport().isCoordinator) return;
        const rejoin = await this.rejoinUnderNewCoordinator(
          selfId,
          lostCoordinatorId,
        );
        if (rejoin.outcome === "joined") return;
        lastDialFailure = rejoin.cause;
      }
      this.deps.onError?.(
        new Error(
          `PeerLifecycle: the vacated coordinator port kept changing hands and this peer neither took it nor found a successor holding it${lastDialFailure === undefined ? "" : `; the last dial failed: ${lastDialFailure.message}`}`,
        ),
      );
    } finally {
      this.contestingCoordinatorRole = false;
    }
  }

  /** Re-introduces this side to whichever survivor won the bind race, over a fresh coordinator connection to the same well-known port. Without it this peer would keep its existing data connections but be unknown to the new coordinator, so it would never appear in the peer list handed to the next joiner. Only a dial that reaches a different device than the lost holder counts as joining: the lost holder's listener can still be accepting while its transport closes, and a peer introduced to it would hold a session to a coordinator that is going away while nobody holds the port. Every dial failure is treated as unsettled rather than final for the same reason, since a connection torn down mid-handshake is what a closing listener produces; the caller answers by re-entering the bind race and reports the last failure only once it has run out of rounds. */
  private async rejoinUnderNewCoordinator(
    selfId: string,
    lostCoordinatorId: string,
  ): Promise<RejoinOutcome> {
    const transport = this.deps.requireTransport();
    try {
      await transport.connectToCoordinator(
        COORDINATOR_HOST,
        this.deps.coordinatorPort,
        selfId,
        transport.dataPort,
      );
    } catch (error) {
      if (isConnectionRefused(error)) return { outcome: "unsettled" };
      return {
        outcome: "unsettled",
        cause: error instanceof Error ? error : new Error(describe(error)),
      };
    }
    if (this.deps.requireTransport().coordinatorPeerId === lostCoordinatorId) {
      return { outcome: "unsettled" };
    }
    return { outcome: "joined" };
  }

  /** Marks a departed peer's own agent offline and announces it, but only from the elected coordinator: the same single-authority rule StaleAgentChecker's PID probe already follows, so a departure produces one announcement rather than one per surviving peer. An agent's id is its peer's id (AgentRegistry.registerAgent), so the departed peer names its own record directly; the PID probe remains the backstop for an agent whose process dies without its session closing, and an already-offline record is left alone, so a successor that took over late announces nothing twice. */
  private async retireDepartedAgent(peerId: string): Promise<void> {
    if (!this.deps.coordinatorRole.isHolder()) return;
    const agent = this.deps.agents.get(peerId);
    if (agent === undefined || agent.status === "offline") return;
    // Bumped so that a state snapshot a survivor sends from before it heard of the departure, which still shows the agent running at its old revision, cannot turn it back on.
    agent.status = "offline";
    this.deps.deliveryEngine.bump(agent);
    this.deps.agents.set(peerId, agent);
    await this.deps.deliveryEngine.notifyRoomsOfStatus(peerId, "offline");
    await this.deps.deliveryEngine.broadcastPatch({
      type: "agent_offline",
      agentId: peerId,
    });
  }

  /** Graceful handover of the well-known port listener (agent-comms#170): called by MeshStore.shutdown() while the transport is still up. The elected coordinator role needs no handover, since survivors recover it from the departure itself. A no-op unless this side currently holds the port listener and at least one other peer remains connected. Neither condition is this class's own business to log or report on, since a solo coordinator shutting down or a non-coordinator peer shutting down are both entirely ordinary. When both hold, picks the longest-running remaining peer (the one with the earliest recorded PeerInfo.startedAt, matching the README's documented policy) as the successor and sends it become_coordinator carrying every other remaining peer, exactly the peerList shape handleBecomeCoordinator already expects (it dials each entry itself; the successor doesn't need to be told about itself). The crash-race path (each surviving peer independently racing to rebind the coordinator port) is a separate mechanism and untouched by this method. */
  async sendCoordinatorHandover(): Promise<void> {
    const transport = this.deps.requireTransport();
    if (!transport.isCoordinator) return;

    const selfId = this.deps.getPeerId();
    const remainingPeers = [...this.deps.peerInfo.values()].filter(
      (peer) => peer.id !== selfId,
    );
    if (remainingPeers.length === 0) return;

    // filter() above already returned a fresh array, so sorting it in place is safe. A start time that does not parse sorts last: an unreadable claim never makes a peer the longest-running one.
    const startedAtMs = (peer: Readonly<PeerInfo>): number =>
      parseIsoTimestampMs(peer.startedAt) ?? Number.POSITIVE_INFINITY;
    remainingPeers.sort((a, b) => {
      const earlier = startedAtMs(a);
      const later = startedAtMs(b);
      return earlier === later ? 0 : earlier < later ? -1 : 1;
    });
    const [successor, ...handoffList] = remainingPeers;
    // remainingPeers.length > 0 (checked above) guarantees at least one entry here -- this narrows the type for TypeScript rather than handling a real runtime case.
    if (successor === undefined) return;

    await transport.send(
      { id: successor.id },
      { method: "become_coordinator", peerList: handoffList },
    );
  }
}

/**
 * PeerLifecycle — the TransportEvents callbacks around a peer's own comings and goings on the mesh: peer-list/peer-joined bookkeeping, the coordinator's own new-peer introduction handshake, post-connection state-sync, inbound data-message routing (state_sync/state_update), taking over as coordinator, and peer disconnection. Split out of mesh-store.ts to reduce it under the repo's max-lines cap.
 */

import { normaliseWireState } from "./wire-protocol.js";
import type {
  MeshMessage,
  PeerInfo,
  SerialisedState,
} from "./wire-protocol.js";
import { isAddrInUse } from "./bind-retry.js";
import { COORDINATOR_HOST } from "./mesh-store-shared.js";
import type { CoordinatorGateway } from "./coordinator-gateway.js";
import type { DeliveryEngine } from "./delivery-engine.js";
import type { RoomProtocol } from "./room-protocol.js";
import type { StaleAgentChecker } from "./stale-agent-checker.js";
import type { ConnectionHandle, MeshTransport } from "./transport.js";
import type { AgentIdentity } from "./types.js";

/** The state and collaborators PeerLifecycle needs from MeshStore. peerInfo/agents are direct references into MeshStore's own fields; coordinatorPort is a readonly value copied once; serialise is MeshStore's own retained method (constraint: it must stay directly on MeshStore.prototype, so PeerLifecycle calls it through this closure rather than owning it); roomProtocol/deliveryEngine/staleAgentChecker/coordinatorGateway are the already-constructed instances (construction order: ... -\> roomProtocol -\> ... -\> staleAgentChecker -\> coordinatorGateway -\> peerLifecycle), narrowed to what peer-lifecycle bookkeeping ever needs. */
export interface PeerLifecycleDeps {
  peerInfo: Map<string, PeerInfo>;
  agents: Map<string, AgentIdentity>;
  coordinatorPort: number;
  getPeerId: () => string;
  /** The peer ID of the coordinator this side currently answers to, as the transport reports it -- undefined when this side is the coordinator itself or has never reached one. Supplied as its own dep rather than read off requireTransport() so the crash-race decision below is expressible against a plain value in tests. */
  getCoordinatorPeerId: () => string | undefined;
  requireTransport: () => MeshTransport;
  serialise: () => SerialisedState;
  roomProtocol: Pick<RoomProtocol, "flushPendingRoomRequests">;
  deliveryEngine: Pick<
    DeliveryEngine,
    "applyStateSync" | "applyPatch" | "notifyRoomsOfStatus" | "broadcastPatch"
  >;
  staleAgentChecker: Pick<StaleAgentChecker, "start">;
  /** Dials the hub the moment this side takes over as coordinator (agent-comms#154) -- see CoordinatorGateway's own class doc. Narrowed to the one method handleBecomeCoordinator ever calls; onLostCoordinator is MeshStore.shutdown()'s own concern, not this class's. */
  coordinatorGateway: Pick<CoordinatorGateway, "onBecameCoordinator">;
  /** Fires alongside coordinatorGateway.onBecameCoordinator, right after this side takes over as coordinator -- MeshStore's own hook for starting a coordinator-only capability that doesn't belong in the transport-agnostic core itself (e.g. the cc-peer front, agent-comms#157). Optional and left unset by most callers, mirroring MeshStore's own onDelivery/onPatch/onError callback fields. */
  onCoordinatorRoleChanged?: (() => void | Promise<void>) | undefined;
  /** Reports a failed takeover or rejoin. The crash-race path runs detached from any caller that could handle a rejection, so this is the only signal that a coordinator loss was noticed but not recovered from. */
  onError?: ((error: Error) => void) | undefined;
}

/** The message an unknown thrown value is reported as, so a takeover or rejoin failure reads the same whether the transport rejected with an Error or something else. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class PeerLifecycle {
  /** Guards against a second contest running while the first is still binding or rejoining -- a coordinator whose process dies can close more than one session to this side, and each close arrives as its own disconnect. */
  private contestingCoordinatorRole = false;

  constructor(private readonly deps: PeerLifecycleDeps) {}

  handlePeerList(peers: readonly PeerInfo[]): void {
    const peerId = this.deps.getPeerId();
    for (const peer of peers) {
      this.deps.peerInfo.set(peer.id, peer);
      // The list always includes this store's own entry — dialling yourself is a wasted connection attempt (and, on some platforms, an immediate self-inflicted ECONNRESET) that never needs to happen.
      if (peer.id === peerId) continue;
      void this.deps.requireTransport().connectToPeer(peer, peerId);
    }
  }

  handlePeerJoined(peer: Readonly<PeerInfo>): void {
    this.deps.peerInfo.set(peer.id, peer);
    const peerId = this.deps.getPeerId();
    if (peer.id === peerId) return;
    void this.deps.requireTransport().connectToPeer(peer, peerId);
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

  async handlePeerConnected(
    handle: Readonly<ConnectionHandle>,
    _info: Readonly<PeerInfo>,
  ): Promise<void> {
    // If we have state and the peer doesn't, send state sync
    if (this.deps.agents.size > 0) {
      const state: SerialisedState = this.deps.serialise();
      await this.deps.requireTransport().send(handle, {
        method: "state_sync",
        state,
      });
    }
    await this.deps.roomProtocol.flushPendingRoomRequests(handle.id);
  }

  async handleDataMessage(
    handle: Readonly<ConnectionHandle>,
    msg: MeshMessage,
  ): Promise<void> {
    if (msg.method === "state_sync") {
      this.deps.deliveryEngine.applyStateSync(normaliseWireState(msg.state));
    } else if (msg.method === "state_update") {
      await this.deps.deliveryEngine.applyPatch(msg.patch);
    }
  }

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
      void this.deps.requireTransport().connectToPeer(peer, peerId);
    }
    this.deps.staleAgentChecker.start();
    await this.deps.coordinatorGateway.onBecameCoordinator();
    await this.deps.onCoordinatorRoleChanged?.();
  }

  handlePeerDisconnected(handle: Readonly<ConnectionHandle>): void {
    void this.handlePeerDeparture(handle.id);
  }

  /** The awaitable form of handlePeerDisconnected, which TransportEvents forces to be synchronous. A departing peer leaves the peer list; when it was this side's own coordinator, its vacated role is contested before anything else, so whoever wins is already coordinator by the time the departed peer's agent record is retired. */
  async handlePeerDeparture(peerId: string): Promise<void> {
    this.deps.peerInfo.delete(peerId);
    if (peerId === this.deps.getCoordinatorPeerId()) {
      await this.contestCoordinatorRole(peerId);
    }
    await this.retireDepartedAgent(peerId);
  }

  /** Races every other surviving peer to rebind the coordinator port, which is what makes a coordinator CRASH recoverable at all: unlike the graceful handover, a killed coordinator names no successor, so each survivor contests independently and the operating system's own exclusive bind decides the single winner. The winner runs the ordinary takeover path (handleBecomeCoordinator) over the peers it still holds connections to; a loser -- the one case where the bind fails specifically because the port is already taken -- re-introduces itself to the winner so it is a full member of the new mesh again, with its own data port known to whoever joins next. Direct peer-to-peer data connections are untouched throughout, so traffic between survivors never depends on the outcome of this race. */
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
      try {
        await this.handleBecomeCoordinator(survivors);
        return;
      } catch (error) {
        if (!isAddrInUse(error)) {
          this.deps.onError?.(
            new Error(
              `PeerLifecycle: could not take over the vacated coordinator role: ${describe(error)}`,
            ),
          );
          return;
        }
      }
      await this.rejoinUnderNewCoordinator(selfId);
    } finally {
      this.contestingCoordinatorRole = false;
    }
  }

  /** Re-introduces this side to whichever survivor won the bind race, over a fresh coordinator connection to the same well-known port. Without it this peer would keep its existing data connections but be unknown to the new coordinator, so it would never appear in the peer list handed to the next joiner. */
  private async rejoinUnderNewCoordinator(selfId: string): Promise<void> {
    const transport = this.deps.requireTransport();
    try {
      await transport.connectToCoordinator(
        COORDINATOR_HOST,
        this.deps.coordinatorPort,
        selfId,
        transport.dataPort,
      );
    } catch (error) {
      this.deps.onError?.(
        new Error(
          `PeerLifecycle: lost the coordinator bind race and could not rejoin under the new coordinator: ${describe(error)}`,
        ),
      );
    }
  }

  /** Marks a departed peer's own agent offline and announces it, but only from the coordinator -- the same single-authority rule StaleAgentChecker's PID probe already follows, so a departure produces one announcement rather than one per surviving peer. An agent's id is its peer's id (AgentRegistry.registerAgent), so the departed peer names its own record directly; the PID probe remains the backstop for an agent whose process dies without its session closing. */
  private async retireDepartedAgent(peerId: string): Promise<void> {
    if (!this.deps.requireTransport().isCoordinator) return;
    const agent = this.deps.agents.get(peerId);
    if (agent === undefined || agent.status === "offline") return;
    agent.status = "offline";
    this.deps.agents.set(peerId, agent);
    await this.deps.deliveryEngine.notifyRoomsOfStatus(peerId, "offline");
    await this.deps.deliveryEngine.broadcastPatch({
      type: "agent_offline",
      agentId: peerId,
    });
  }

  /** Graceful coordinator handover (agent-comms#170): called by MeshStore.shutdown() while the transport is still up. A no-op unless this side currently holds the coordinator role and at least one other peer remains connected -- neither condition is this class's own business to log or report on, since a solo coordinator shutting down or a non-coordinator peer shutting down are both entirely ordinary. When both hold, picks the longest-running remaining peer (the one with the earliest recorded PeerInfo.startedAt, matching the README's documented policy) as the successor and sends it become_coordinator carrying every other remaining peer -- exactly the peerList shape handleBecomeCoordinator already expects (it dials each entry itself; the successor doesn't need to be told about itself). The crash-race path (each surviving peer independently racing to rebind the coordinator port) is a separate mechanism and untouched by this method. */
  async sendCoordinatorHandover(): Promise<void> {
    const transport = this.deps.requireTransport();
    if (!transport.isCoordinator) return;

    const selfId = this.deps.getPeerId();
    const remainingPeers = [...this.deps.peerInfo.values()].filter(
      (peer) => peer.id !== selfId,
    );
    if (remainingPeers.length === 0) return;

    // filter() above already returned a fresh array, so sorting it in place is safe.
    remainingPeers.sort(
      (a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt),
    );
    const [successor, ...handoffList] = remainingPeers;
    // remainingPeers.length > 0 (checked above) guarantees at least one entry here -- this narrows the type for TypeScript rather than handling a real runtime case.
    if (successor === undefined) return;

    await transport.send(
      { id: successor.id },
      { method: "become_coordinator", peerList: handoffList },
    );
  }
}

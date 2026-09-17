/**
 * PeerLifecycle — the TransportEvents callbacks around a peer's own comings and goings on the mesh: peer-list/peer-joined bookkeeping, the coordinator's own new-peer introduction handshake, post-connection state-sync, inbound data-message routing (state_sync/state_update), taking over as coordinator, and peer disconnection. Split out of mesh-store.ts to reduce it under the repo's max-lines cap.
 */

import { normaliseWireState } from "./wire-protocol.js";
import type {
  MeshMessage,
  PeerInfo,
  SerialisedState,
} from "./wire-protocol.js";
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
  requireTransport: () => MeshTransport;
  serialise: () => SerialisedState;
  roomProtocol: Pick<RoomProtocol, "flushPendingRoomRequests">;
  deliveryEngine: Pick<DeliveryEngine, "applyStateSync" | "applyPatch">;
  staleAgentChecker: Pick<StaleAgentChecker, "start">;
  /** Dials the hub the moment this side takes over as coordinator (agent-comms#154) -- see CoordinatorGateway's own class doc. Narrowed to the one method handleBecomeCoordinator ever calls; onLostCoordinator is MeshStore.shutdown()'s own concern, not this class's. */
  coordinatorGateway: Pick<CoordinatorGateway, "onBecameCoordinator">;
  /** Fires alongside coordinatorGateway.onBecameCoordinator, right after this side takes over as coordinator -- MeshStore's own hook for starting a coordinator-only capability that doesn't belong in the transport-agnostic core itself (e.g. the cc-peer front, agent-comms#157). Optional and left unset by most callers, mirroring MeshStore's own onDelivery/onPatch/onError callback fields. */
  onCoordinatorRoleChanged?: (() => void | Promise<void>) | undefined;
}

export class PeerLifecycle {
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
    this.deps.peerInfo.clear();
    const peerId = this.deps.getPeerId();
    for (const peer of peerList) {
      this.deps.peerInfo.set(peer.id, peer);
      void this.deps.requireTransport().connectToPeer(peer, peerId);
    }
    this.deps.staleAgentChecker.start();
    await this.deps.coordinatorGateway.onBecameCoordinator();
    await this.deps.onCoordinatorRoleChanged?.();
  }

  handlePeerDisconnected(handle: Readonly<ConnectionHandle>): void {
    this.deps.peerInfo.delete(handle.id);
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

    const bySuccession = [...remainingPeers].sort(
      (a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt),
    );
    const [successor, ...handoffList] = bySuccession;
    // remainingPeers.length > 0 (checked above) guarantees bySuccession has at least one entry -- this narrows the type for TypeScript rather than handling a real runtime case.
    if (successor === undefined) return;

    await transport.send(
      { id: successor.id },
      { method: "become_coordinator", peerList: handoffList },
    );
  }
}

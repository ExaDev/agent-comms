/**
 * MeshStore — transport-agnostic peer mesh for agent communication.
 *
 * Each bridge instance is a peer in the mesh. Peers discover each other
 * via a coordinator (the first instance to bind the well-known port).
 * All state is held in memory and synchronised between peers.
 * Delivery events are pushed directly over the transport — no polling,
 * no filesystem.
 *
 * Transport is set via setTransport() (e.g. WireMeshTransport for encrypted
 * connections) before init() or any other transport-using method is called
 * -- there is no default, since every real bridge builds its own transport
 * from this store's own events getter, which needs the store to already
 * exist.
 */

import * as os from "node:os";
import { nanoid } from "./nanoid.js";
import { CommsError } from "./store.js";
import { normaliseWireState } from "./wire-protocol.js";
import { dmRoomPath, ownerNamedRoomPath, slugRoomName } from "./room-path.js";
import type { SerialisedState } from "./wire-protocol.js";
import { DiscoveryManager } from "./discovery.js";
import { MdnsDiscoveryBackend } from "./discovery-mdns.js";
import { TailscaleDiscoveryBackend } from "./discovery-tailscale.js";
import { FederationManager } from "./federation.js";
import type { FedLink } from "./federation.js";
import { getCertificateFingerprint } from "./identity.js";
import type { MeshMessage, MeshStatePatch, PeerInfo } from "./wire-protocol.js";
import type {
  ConnectionHandle,
  MeshTransport,
  TransportEvents,
} from "./transport.js";
import type { CommsStore } from "./comms-store.js";
import type {
  AgentIdentity,
  AgentStatus,
  DeliveryEvent,
  DeliveryStatus,
  DmMessage,
  MeshVisibility,
  NetworkInterface,
  Room,
  RoomMessage,
  RoomType,
  StreamingBehavior,
  Visibility,
} from "./types.js";
import type { ListenerInfo, ListenerPolicy } from "./transport.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_COORDINATOR_PORT = 19876;
const COORDINATOR_HOST = "127.0.0.1";

/**
 * Bound on pending delivery events held per target agent. Events beyond the
 * bound drop oldest-first: a long-offline agent's queue cannot grow without
 * limit in memory or in synced snapshots (#28).
 */
const MAX_QUEUED_DELIVERIES_PER_AGENT = 100;

/**
 * Merge an incoming append-only message history into the local one: add
 * entries the local list does not have and union read receipts on the ones
 * it does. Local ordering is preserved; unseen entries are appended.
 */
function mergeMessageHistories<T extends { id: string; readBy: string[] }>(
  local: T[],
  incoming: T[],
): void {
  const byId = new Map(local.map((m) => [m.id, m]));
  for (const msg of incoming) {
    const existing = byId.get(msg.id);
    if (existing === undefined) {
      local.push(msg);
      byId.set(msg.id, msg);
      continue;
    }
    for (const reader of msg.readBy) {
      if (!existing.readBy.includes(reader)) existing.readBy.push(reader);
    }
  }
}

// ---------------------------------------------------------------------------
// MeshStore
// ---------------------------------------------------------------------------

export class MeshStore implements CommsStore {
  peerId: string;
  readonly startedAt: string;
  readonly coordinatorPort: number;

  private agents = new Map<string, AgentIdentity>();
  private rooms = new Map<string, Room>();
  private messages = new Map<string, RoomMessage[]>();
  private dms = new Map<string, DmMessage[]>();
  private deliveryQueues = new Map<string, DeliveryEvent[]>();
  private identityCache = new Map<string, { id: string }>();

  private transport: MeshTransport | undefined;
  private peerInfo = new Map<string, PeerInfo>();
  private staleCheckTimer: ReturnType<typeof setInterval> | undefined;
  private isShutDown = false;
  private initialised = false;
  private pendingMarkReadTimers: ReturnType<typeof setTimeout>[] = [];

  /** Whether the mesh has a live coordinator connection. */
  get connected(): boolean {
    return (
      this.requireTransport().isCoordinator ||
      this.requireTransport().hasCoordinatorConnection
    );
  }

  // -- Pending inbound connections awaiting approval --
  private pendingInboundConnections = new Map<
    string,
    { peerId: string; dataPort: number; name: string; fingerprint: string }
  >();

  onDelivery:
    | ((agentId: string, event: DeliveryEvent) => void | Promise<void>)
    | undefined;

  /** Fires for every state patch — both locally generated and remote. */
  onPatch: ((patch: MeshStatePatch) => void | Promise<void>) | undefined;

  /**
   * Fires for a transport-level error a caller may want to observe (a connection rejected for presenting a certificate that doesn't match its claimed peer ID, this store's own inability to join or create a mesh, etc). Previously wired to `this.events.onError` inside this class's own methods, but the `events` getter never actually implemented `onError` on the object it returns, so every one of those calls was silently a no-op -- this store had no way to observe its own transport failures at all. Left undefined by default (matching onDelivery/onPatch): a caller that wants visibility sets it, exactly like those two.
   */
  onError: ((error: Error) => void) | undefined;

  /** Serialise the full mesh state for state_sync messages. */
  serialise(): SerialisedState {
    return {
      agents: Object.fromEntries(this.agents),
      rooms: Object.fromEntries(this.rooms),
      messages: Object.fromEntries(this.messages),
      dms: Object.fromEntries(this.dms),
      deliveryQueues: Object.fromEntries(this.deliveryQueues),
    };
  }

  private lastLocalDeliveryKey: string | undefined;
  private localDeliveryKeys = new Set<string>();

  discovery: DiscoveryManager;
  federation: FederationManager;

  constructor(coordinatorPort: number = DEFAULT_COORDINATOR_PORT) {
    this.peerId = nanoid(8);
    this.startedAt = new Date().toISOString();
    this.coordinatorPort = coordinatorPort;

    // Discovery manager — registers available backends
    this.discovery = new DiscoveryManager();
    this.discovery.registerBackend(new MdnsDiscoveryBackend());
    this.discovery.registerBackend(new TailscaleDiscoveryBackend());

    // Federation manager — coordinator-to-coordinator links
    this.federation = new FederationManager(
      this.peerId, // mesh ID is the coordinator's peer ID
      `mesh-${this.peerId}`,
      {
        onAgentVisible: (agent) => this.handleFedAgentVisible(agent),
        onAgentGone: (agentId) => this.handleFedAgentGone(agentId),
        onRoomMessage: (roomId, message) =>
          this.handleFedRoomMessage(roomId, message),
        onRoomJoin: (roomId, agentId, agentName) =>
          this.handleFedRoomJoin(roomId, agentId, agentName),
        onRoomLeave: (roomId, agentId) =>
          this.handleFedRoomLeave(roomId, agentId),
        getVisibleAgents: () => this.getVisibleAgentsForFed(),
        getFederatedRoomMemberships: () =>
          this.getFederatedRoomMembershipsForFed(),
      },
    );
  }

  /** Sets the transport (e.g. WireMeshTransport for encrypted connections). Must be called before init() or any other transport-using method. */
  setTransport(transport: MeshTransport): void {
    this.transport = transport;
  }

  /** The set transport, or throws if setTransport() hasn't been called yet -- the single place every transport-using method reads through, so the "must call setTransport() first" contract is enforced at one boundary rather than checked ad hoc at each call site. */
  private requireTransport(): MeshTransport {
    if (this.transport === undefined) {
      throw new Error(
        "MeshStore: no transport set; call setTransport() before using the store",
      );
    }
    return this.transport;
  }

  // -----------------------------------------------------------------------
  // Mesh lifecycle
  // -----------------------------------------------------------------------

  async init(): Promise<void> {
    if (this.initialised) return;
    this.initialised = true;
    await this.requireTransport().startDataServer();

    // Register our own peer info
    this.peerInfo.set(this.peerId, {
      id: this.peerId,
      port: this.requireTransport().dataPort,
      startedAt: this.startedAt,
    });

    // Try joining an existing mesh; fall back to becoming coordinator.
    //
    // Single attempt: connect to an existing coordinator, or become one.
    // If the coordinator port is occupied but unresponsive (e.g. an orphan
    // process from a previous session), degrade gracefully instead of
    // retrying. Retrying tls.connect after a failed handshake to a
    // non-TLS endpoint can freeze the event loop (Node.js TLS session
    // cache bug), so we only try once.
    let connected = false;

    try {
      await this.requireTransport().connectToCoordinator(
        COORDINATOR_HOST,
        this.coordinatorPort,
        this.peerId,
        this.requireTransport().dataPort,
      );
      connected = true;
    } catch {
      try {
        await this.requireTransport().becomeCoordinator(
          COORDINATOR_HOST,
          this.coordinatorPort,
        );
        this.startStaleCheck();
        connected = true;
      } catch (coordErr) {
        const msg =
          coordErr instanceof Error ? coordErr.message : String(coordErr);
        if (!msg.includes("EADDRINUSE")) {
          throw coordErr;
        }
        // EADDRINUSE — port held by an unresponsive process. Degrade.
      }
    }

    if (!connected) {
      this.events.onError?.(
        new Error(
          `MeshStore: could not join or create mesh on port ${String(this.coordinatorPort)}. ` +
            "Running without mesh — agent-comms will be unavailable.",
        ),
      );
      return;
    }

    this.requireTransport().unref();
  }

  // -----------------------------------------------------------------------
  // TransportEvents — callbacks from the transport layer
  // -----------------------------------------------------------------------

  private handlePeerList(peers: PeerInfo[]): void {
    for (const peer of peers) {
      this.peerInfo.set(peer.id, peer);
      // The list always includes this store's own entry — dialling yourself is a wasted connection attempt (and, on some platforms, an immediate self-inflicted ECONNRESET) that never needs to happen.
      if (peer.id === this.peerId) continue;
      void this.requireTransport().connectToPeer(peer, this.peerId);
    }
  }

  private handlePeerJoined(peer: PeerInfo): void {
    this.peerInfo.set(peer.id, peer);
    if (peer.id === this.peerId) return;
    void this.requireTransport().connectToPeer(peer, this.peerId);
  }

  private async handleIntroduction(
    handle: ConnectionHandle,
    msg: { peerId: string; dataPort: number },
  ): Promise<void> {
    const newPeer: PeerInfo = {
      id: msg.peerId,
      port: msg.dataPort,
      startedAt: new Date().toISOString(),
    };
    this.peerInfo.set(msg.peerId, newPeer);

    // Send full peer list to the new peer
    const peerList: MeshMessage = {
      method: "peer_list",
      peers: [...this.peerInfo.values()],
    };
    await this.requireTransport().send(handle, peerList);

    // Broadcast arrival to all existing peers
    const joined: MeshMessage = { method: "peer_joined", peer: newPeer };
    await this.requireTransport().broadcast(joined);

    // Connect to the new peer's data server
    void this.requireTransport().connectToPeer(newPeer, this.peerId);
  }

  private async handlePeerConnected(
    handle: ConnectionHandle,
    _info: PeerInfo,
  ): Promise<void> {
    // If we have state and the peer doesn't, send state sync
    if (this.agents.size > 0) {
      const state: SerialisedState = this.serialise();
      await this.requireTransport().send(handle, {
        method: "state_sync",
        state,
      });
    }
  }

  /**
   * Merge a peer's state snapshot into the local state. Agents and rooms
   * accept the incoming copy when it carries a revision at least as high as
   * the local one, so a peer holding stale entities converges when it
   * receives a fresher snapshot, while its own stale copies are rejected by
   * peers that stayed current (#27). Message and DM histories are
   * append-only: add unseen entries and union read receipts.
   */
  applyStateSync(state: SerialisedState): void {
    const incoming = {
      agents: new Map(Object.entries(state.agents)),
      rooms: new Map(Object.entries(state.rooms)),
      messages: new Map(Object.entries(state.messages)),
      dms: new Map(Object.entries(state.dms)),
    };
    {
      for (const [id, agent] of incoming.agents) {
        const existingVersion = this.agents.get(id)?.version;
        if (existingVersion !== undefined && agent.version < existingVersion) {
          continue;
        }
        if (existingVersion === agent.version) {
          const existing = this.agents.get(id);
          if (existing) {
            for (const r of existing.subscribedRooms) {
              if (!agent.subscribedRooms.includes(r))
                agent.subscribedRooms.push(r);
            }
          }
        }
        this.agents.set(id, agent);
      }
      for (const [id, room] of incoming.rooms) {
        const existingVersion = this.rooms.get(id)?.version;
        if (existingVersion !== undefined && room.version < existingVersion) {
          continue;
        }
        this.mergeRoom(room);
      }
      for (const [id, msgs] of incoming.messages) {
        const existing = this.messages.get(id);
        if (existing === undefined) {
          this.messages.set(id, msgs);
          continue;
        }
        mergeMessageHistories(existing, msgs);
      }
      for (const [id, dmMsgs] of incoming.dms) {
        const existing = this.dms.get(id);
        if (existing === undefined) {
          this.dms.set(id, dmMsgs);
          continue;
        }
        mergeMessageHistories(existing, dmMsgs);
      }
      for (const [agentId, events] of Object.entries(state.deliveryQueues)) {
        const seen = new Set(
          (this.deliveryQueues.get(agentId) ?? []).map((e) =>
            JSON.stringify(e),
          ),
        );
        for (const event of events) {
          if (seen.has(JSON.stringify(event))) continue;
          this.queueDelivery(agentId, event);
          // Replay fires only for events with consumption evidence (#28):
          // messages are consumed by reading (readBy), invites by acceptance
          // or decline (no longer in the invited list). Transient
          // notifications (member_joined, room_members, connection_request,
          // delivery status) carry no consumption evidence, so replaying
          // them could only ever duplicate-notify; the state they describe
          // arrives via the synced room and agent records instead. They
          // still merge into the queue, so drain bridges see them.
          if (event.type === "room_message" || event.type === "dm") {
            this.fireLocalDelivery(agentId, event);
          } else if (event.type === "room_invite") {
            const stillInvited = this.rooms
              .get(event.room)
              ?.invited.includes(agentId);
            if (stillInvited === true) {
              this.fireLocalDelivery(agentId, event);
            }
          }
        }
      }
    }
  }

  private async handleDataMessage(
    handle: ConnectionHandle,
    msg: MeshMessage,
  ): Promise<void> {
    if (msg.method === "state_sync") {
      this.applyStateSync(normaliseWireState(msg.state));
    } else if (msg.method === "state_update") {
      await this.applyPatch(msg.patch);
    }
  }

  private async handleBecomeCoordinator(peerList: PeerInfo[]): Promise<void> {
    // Take over as coordinator using the data server we already have
    await this.requireTransport().becomeCoordinator(
      COORDINATOR_HOST,
      this.coordinatorPort,
    );
    this.peerInfo.clear();
    for (const peer of peerList) {
      this.peerInfo.set(peer.id, peer);
      void this.requireTransport().connectToPeer(peer, this.peerId);
    }
    this.startStaleCheck();
  }

  private handlePeerDisconnected(handle: ConnectionHandle): void {
    this.peerInfo.delete(handle.id);
  }

  // -----------------------------------------------------------------------
  // Connection approval
  // -----------------------------------------------------------------------

  private handleConnectionRequest(
    handle: ConnectionHandle,
    request: {
      peerId: string;
      dataPort: number;
      name: string;
      fingerprint: string;
    },
  ): void {
    this.pendingInboundConnections.set(handle.id, {
      peerId: request.peerId,
      dataPort: request.dataPort,
      name: request.name,
      fingerprint: request.fingerprint,
    });

    // Deliver connection_request event to the owning agent
    const connectionId = handle.id;
    const event: DeliveryEvent = {
      type: "connection_request",
      connectionId,
      peerId: request.peerId,
      dataPort: request.dataPort,
      name: request.name,
      fingerprint: request.fingerprint,
    };
    this.queueDelivery(this.peerId, event);
    if (this.onDelivery) {
      void this.onDelivery(this.peerId, event);
    }
  }

  /** Accept a pending inbound connection. */
  async acceptConnection(connectionId: string): Promise<void> {
    const pending = this.pendingInboundConnections.get(connectionId);
    if (!pending) {
      throw new Error(`No pending connection ${connectionId}`);
    }
    this.pendingInboundConnections.delete(connectionId);
    const handle: ConnectionHandle = { id: connectionId };
    await this.requireTransport().acceptConnection(handle);
  }

  /** Reject a pending inbound connection. */
  async rejectConnection(connectionId: string, reason: string): Promise<void> {
    const pending = this.pendingInboundConnections.get(connectionId);
    if (!pending) {
      throw new Error(`No pending connection ${connectionId}`);
    }
    this.pendingInboundConnections.delete(connectionId);
    const handle: ConnectionHandle = { id: connectionId };
    await this.requireTransport().rejectConnection(handle, reason);
  }

  /** List all pending inbound connections awaiting approval. */
  listPendingConnections(): {
    connectionId: string;
    peerId: string;
    dataPort: number;
    name: string;
    fingerprint: string;
  }[] {
    return [...this.pendingInboundConnections.entries()].map(([id, info]) => ({
      connectionId: id,
      ...info,
    }));
  }

  /** Initiate an outbound connection to a remote coordinator requiring approval.
   *  Fires the connect_request and returns immediately. The connection
   *  completes asynchronously when the coordinator accepts or rejects. */
  connectToRemote(host: string, port: number): Promise<void> {
    const agent = this.agents.get(this.peerId);
    // Fire-and-forget: don't await the full approval handshake.
    // The coordinator will either accept (triggering normal introduction flow)
    // or reject (closing the socket). Handle rejection to avoid unhandled rejection.
    this.requireTransport()
      .connectToRemote(
        host,
        port,
        this.peerId,
        this.requireTransport().dataPort,
        agent?.name ?? "",
        "",
      )
      .catch(() => {
        // Rejection is expected when the coordinator denies the connection.
        // Log silently — the calling tool already returned success.
      });

    return Promise.resolve();
  }

  /** Start only the data server without connecting to a coordinator.
   *  Used for testing scenarios where the peer connects via connectToRemote. */
  async startDataServerOnly(): Promise<void> {
    await this.requireTransport().startDataServer();
    this.peerInfo.set(this.peerId, {
      id: this.peerId,
      port: this.requireTransport().dataPort,
      startedAt: this.startedAt,
    });
    this.requireTransport().unref();
  }

  // -----------------------------------------------------------------------
  // Transport events accessor (for bridges to wire up)
  // -----------------------------------------------------------------------

  /** Returns the TransportEvents object that bridges should pass to the transport constructor. */
  get events(): TransportEvents {
    return {
      onMessage: (handle, msg) => {
        void this.handleDataMessage(handle, msg);
      },
      onPeerConnected: (handle, info) => {
        void this.handlePeerConnected(handle, info);
      },
      onPeerDisconnected: (handle) => {
        this.handlePeerDisconnected(handle);
      },
      onIntroduction: (handle, msg) => {
        void this.handleIntroduction(handle, msg);
      },
      onPeerList: (peers) => {
        this.handlePeerList(peers);
      },
      onPeerJoined: (peer) => {
        this.handlePeerJoined(peer);
      },
      onBecomeCoordinator: (peerList) => {
        void this.handleBecomeCoordinator(peerList);
      },
      onConnectionRequest: (handle, request) => {
        this.handleConnectionRequest(handle, request);
      },
      onError: (error) => {
        this.onError?.(error);
      },
    };
  }

  /** Append to a target agent's delivery queue, bounded oldest-first (#28). */
  private queueDelivery(agentId: string, event: DeliveryEvent): void {
    const arr = this.deliveryQueues.get(agentId) ?? [];
    arr.push(event);
    if (arr.length > MAX_QUEUED_DELIVERIES_PER_AGENT) {
      arr.splice(0, arr.length - MAX_QUEUED_DELIVERIES_PER_AGENT);
    }
    this.deliveryQueues.set(agentId, arr);
  }

  /**
   * Merge an incoming room record into the local one. Scalar fields follow
   * the version gate the caller already applied (an equal or higher version
   * reaches here), while membership is always element-merged per agent by
   * highest operation revision, so concurrent joins of different agents
   * survive and a kick racing a join converges with the kick honoured
   * (#27). The members and invited views are re-derived from the merged
   * operations.
   */
  private mergeRoom(incoming: Room): void {
    const existing = this.rooms.get(incoming.id);
    if (existing === undefined) {
      this.refreshMembership(incoming);
      this.rooms.set(incoming.id, incoming);
      return;
    }
    existing.version = Math.max(existing.version, incoming.version);
    existing.name = incoming.name;
    existing.type = incoming.type;
    existing.owner = incoming.owner;
    existing.createdAt = incoming.createdAt;
    existing.description = incoming.description;
    if (incoming.federated !== undefined)
      existing.federated = incoming.federated;
    existing.memberJoins = MeshStore.mergeMemberOps(
      existing.memberJoins,
      incoming.memberJoins,
    );
    existing.memberLeaves = MeshStore.mergeMemberOps(
      existing.memberLeaves,
      incoming.memberLeaves,
    );
    existing.invitedJoins = MeshStore.mergeMemberOps(
      existing.invitedJoins,
      incoming.invitedJoins,
    );
    existing.invitedLeaves = MeshStore.mergeMemberOps(
      existing.invitedLeaves,
      incoming.invitedLeaves,
    );
    this.refreshMembership(existing);
  }

  /**
   * Derive the members and invited views from the per-agent operation maps.
   * An agent is in the list when their latest join strictly outranks their
   * latest leave; equal revisions mean the leave wins, so a kick racing a
   * concurrent join converges with the kick honoured (#27).
   */
  private refreshMembership(room: Room): void {
    room.members = Object.keys(room.memberJoins).filter(
      (id) => (room.memberJoins[id] ?? 0) > (room.memberLeaves[id] ?? 0),
    );
    room.invited = Object.keys(room.invitedJoins).filter(
      (id) => (room.invitedJoins[id] ?? 0) > (room.invitedLeaves[id] ?? 0),
    );
  }

  /** Record a membership operation at the room's current revision. */
  private recordMemberOp(
    room: Room,
    list: "member" | "invited",
    op: "join" | "leave",
    agentId: string,
  ): void {
    const joins = list === "member" ? room.memberJoins : room.invitedJoins;
    const leaves = list === "member" ? room.memberLeaves : room.invitedLeaves;
    const stamp = room.version;
    if (op === "join") joins[agentId] = stamp;
    else leaves[agentId] = stamp;
  }

  /** Merge per-agent operation maps by highest revision per agent. */
  private static mergeMemberOps(
    local: Record<string, number>,
    incoming: Record<string, number>,
  ): Record<string, number> {
    const merged: Record<string, number> = { ...local };
    for (const [id, stamp] of Object.entries(incoming)) {
      if (stamp > (merged[id] ?? 0)) merged[id] = stamp;
    }
    return merged;
  }

  /** Bump an entity's sync revision; call before broadcasting a local mutation. */
  private bump<T extends { version: number }>(entity: T): T {
    entity.version += 1;
    return entity;
  }

  // -----------------------------------------------------------------------
  // State patch application
  // -----------------------------------------------------------------------

  private async applyPatch(patch: MeshStatePatch): Promise<void> {
    switch (patch.type) {
      case "agent_upsert": {
        const existingAgent = this.agents.get(patch.agent.id);
        if (
          existingAgent !== undefined &&
          patch.agent.version < existingAgent.version
        ) {
          // Stale copy from a peer that missed updates (#27).
          break;
        }
        const merged = patch.agent;
        if (existingAgent?.version === patch.agent.version) {
          // Concurrent mutations from the same base: keep subscriptions
          // gained locally. A strictly higher version replaces the record.
          for (const r of existingAgent.subscribedRooms) {
            if (!merged.subscribedRooms.includes(r))
              merged.subscribedRooms.push(r);
          }
        }
        this.agents.set(merged.id, merged);
        break;
      }
      case "agent_offline": {
        const agent = this.agents.get(patch.agentId);
        if (agent) {
          agent.status = "offline";
          this.agents.set(patch.agentId, agent);
        }
        break;
      }
      case "room_upsert": {
        const existing = this.rooms.get(patch.room.id);
        if (existing !== undefined && patch.room.version < existing.version) {
          // Stale copy from a peer that missed updates (#27).
          break;
        }
        this.mergeRoom(patch.room);
        break;
      }
      case "room_delete":
        this.rooms.delete(patch.roomId);
        break;
      case "message_add": {
        const arr = this.messages.get(patch.roomId) ?? [];
        arr.push(patch.message);
        this.messages.set(patch.roomId, arr);
        break;
      }
      case "dm_add": {
        const arr = this.dms.get(patch.key) ?? [];
        arr.push(patch.message);
        this.dms.set(patch.key, arr);
        break;
      }
      case "delivery": {
        this.queueDelivery(patch.agentId, patch.event);
        if (patch.agentId === this.peerId && this.onDelivery) {
          // Deduplicate against local deliveries
          const eventKey = JSON.stringify(patch.event);
          if (this.localDeliveryKeys.has(eventKey)) break;
          this.localDeliveryKeys.add(eventKey);
          if (this.localDeliveryKeys.size > 50) {
            const oldest = this.localDeliveryKeys.values().next().value;
            if (oldest !== undefined) this.localDeliveryKeys.delete(oldest);
          }
          void this.onDelivery(patch.agentId, patch.event);
          // Auto-mark read — scheduled as a macrotask to yield to the event
          // loop. Without this yield, the delivery → markRead → broadcast
          // → peer receives → handleDataMessage chain monopolises the
          // microtask queue and starves macrotasks (timers, new connections,
          // sendRoomMessage return values).
          const evt = patch.event;
          const timer = setTimeout(() => {
            if (this.isShutDown) return;
            if (evt.type === "room_message") {
              void this.markRead(evt.message.id, this.peerId, evt.message.room);
            } else if (evt.type === "dm") {
              void this.markRead(evt.message.id, this.peerId);
            }
          }, 0);
          if (!this.isShutDown) this.pendingMarkReadTimers.push(timer);
        }
        break;
      }
      case "message_read": {
        this.applyReadReceipt(patch.messageId, patch.readBy, patch.room);
        break;
      }
    }

    if (this.onPatch) {
      await this.onPatch(patch);
    }
  }

  // -----------------------------------------------------------------------
  // Broadcast
  // -----------------------------------------------------------------------

  private async broadcastPatch(patch: MeshStatePatch): Promise<void> {
    await this.requireTransport().broadcast({ method: "state_update", patch });
    if (this.onPatch) {
      await this.onPatch(patch);
    }
  }

  private async deliverLocallyAndBroadcast(
    agentId: string,
    event: DeliveryEvent,
  ): Promise<void> {
    // Local delivery
    this.queueDelivery(agentId, event);

    // Auto-emit delivered status for messages
    if (event.type === "room_message") {
      await this.emitDeliveryStatus(
        event.message.id,
        agentId,
        "delivered",
        event.message.room,
      );
    } else if (event.type === "dm") {
      await this.emitDeliveryStatus(event.message.id, agentId, "delivered");
    }

    this.fireLocalDelivery(agentId, event);

    // Remote delivery
    const patch: MeshStatePatch = { type: "delivery", agentId, event };
    await this.broadcastPatch(patch);
  }

  /**
   * Fire onDelivery for an event targeting this peer's own agent, deduped
   * against events already delivered in this process. Used both for live
   * deliveries and for replays of events that accumulated while this
   * process was down (#28): the dedup set is per-process, so a replayed
   * event this process never saw fires, and one it already handled does
   * not.
   */
  private fireLocalDelivery(agentId: string, event: DeliveryEvent): void {
    if (agentId !== this.peerId || !this.onDelivery) return;
    // A room message or DM this agent has already read was already pushed
    // and consumed: read receipts mutate the event between snapshots, so a
    // plain structural key would miss and re-fire on the next sync (#28).
    if (
      (event.type === "room_message" || event.type === "dm") &&
      event.message.readBy.includes(agentId)
    ) {
      return;
    }
    const eventKey = JSON.stringify(event);
    if (this.localDeliveryKeys.has(eventKey)) return;
    this.localDeliveryKeys.add(eventKey);
    // Prevent unbounded growth — evict oldest when cap reached
    if (this.localDeliveryKeys.size > 50) {
      const oldest = this.localDeliveryKeys.values().next().value;
      if (oldest !== undefined) this.localDeliveryKeys.delete(oldest);
    }
    void this.onDelivery(agentId, event);
    // Delivered to this process, so no longer pending for it. Peers that
    // never fired the event keep their copies, which is what a restart
    // replays from (#28). Key-based match: replayed events are JSON clones.
    const queued = this.deliveryQueues.get(agentId);
    if (queued !== undefined) {
      const idx = queued.findIndex((e) => JSON.stringify(e) === eventKey);
      if (idx !== -1) queued.splice(idx, 1);
    }
    // Auto-mark read — scheduled as a macrotask to yield to the event loop.
    const timer = setTimeout(() => {
      if (this.isShutDown) return;
      if (event.type === "room_message") {
        void this.markRead(event.message.id, agentId, event.message.room);
      } else if (event.type === "dm") {
        void this.markRead(event.message.id, agentId);
      }
    }, 0);
    if (!this.isShutDown) this.pendingMarkReadTimers.push(timer);
  }

  private async deliverToRoom(
    roomId: string,
    event: DeliveryEvent,
    excludeAgent?: string,
  ): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room) return;
    for (const memberId of room.members) {
      if (memberId === excludeAgent) continue;
      await this.deliverLocallyAndBroadcast(memberId, event);
    }
  }

  private async notifyRoomsOfStatus(
    agentId: string,
    status: AgentStatus,
  ): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    for (const roomId of agent.subscribedRooms) {
      await this.deliverToRoom(roomId, {
        type: "member_status",
        room: roomId,
        agent: agentId,
        status,
      });
    }
  }

  private async notifyRoomsOfNameChange(
    agentId: string,
    oldName: string,
    newName: string,
  ): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    const event: DeliveryEvent = {
      type: "name_changed",
      agent: agentId,
      oldName,
      newName,
    };
    for (const roomId of agent.subscribedRooms) {
      await this.deliverToRoom(roomId, event, agentId);
    }
    // Also deliver to the agent itself so it sees confirmation
    await this.deliverLocallyAndBroadcast(agentId, event);
  }

  private async emitDeliveryStatus(
    messageId: string,
    agentId: string,
    status: DeliveryStatus,
    room?: string,
  ): Promise<void> {
    // Find the sender for this message
    const senderId = this.findMessageSender(messageId, room);
    if (!senderId) return;
    await this.deliverLocallyAndBroadcast(senderId, {
      type: "delivery_status",
      messageId,
      agent: agentId,
      status,
      room,
    });
  }

  private findMessageSender(
    messageId: string,
    room?: string,
  ): string | undefined {
    if (room) {
      const msgs = this.messages.get(room);
      if (msgs) {
        const msg = msgs.find((m) => m.id === messageId);
        if (msg) return msg.from;
      }
    } else {
      // DM — search all DM queues
      for (const [, msgs] of this.dms) {
        const msg = msgs.find((m) => m.id === messageId);
        if (msg) return msg.from;
      }
    }
    return undefined;
  }

  private async markRead(
    messageId: string,
    readBy: string,
    room?: string,
  ): Promise<void> {
    // Update local message state
    if (room) {
      const msgs = this.messages.get(room);
      if (msgs) {
        const msg = msgs.find((m) => m.id === messageId);
        if (msg && !msg.readBy.includes(readBy)) {
          msg.readBy.push(readBy);
        }
      }
    } else {
      for (const [, msgs] of this.dms) {
        const msg = msgs.find((m) => m.id === messageId);
        if (msg && !msg.readBy.includes(readBy)) {
          msg.readBy.push(readBy);
        }
      }
    }

    // Notify sender
    await this.emitDeliveryStatus(messageId, readBy, "read", room);

    // Propagate to other peers
    await this.broadcastPatch(
      room
        ? { type: "message_read", messageId, readBy, room }
        : { type: "message_read", messageId, readBy },
    );
  }

  private applyReadReceipt(
    messageId: string,
    readBy: string,
    room?: string,
  ): void {
    if (room) {
      const msgs = this.messages.get(room);
      if (msgs) {
        const msg = msgs.find((m) => m.id === messageId);
        if (msg && !msg.readBy.includes(readBy)) {
          msg.readBy.push(readBy);
        }
      }
    } else {
      for (const [, msgs] of this.dms) {
        const msg = msgs.find((m) => m.id === messageId);
        if (msg && !msg.readBy.includes(readBy)) {
          msg.readBy.push(readBy);
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // CommsStore — Identity
  // -----------------------------------------------------------------------

  async readIdentity(
    harness: string,
    cwd: string,
  ): Promise<{ id: string } | undefined> {
    await Promise.resolve();
    return this.identityCache.get(`${harness}--${cwd}`);
  }

  async writeIdentity(harness: string, cwd: string, id: string): Promise<void> {
    await Promise.resolve();
    this.identityCache.set(`${harness}--${cwd}`, { id });
  }

  // -----------------------------------------------------------------------
  // CommsStore — Agent registry
  // -----------------------------------------------------------------------

  async registerAgent(opts: {
    name: string;
    harness: string;
    cwd: string;
    pid: number;
    visibility: Visibility;
    tags: string[];
  }): Promise<AgentIdentity> {
    const existing = await this.readIdentity(opts.harness, opts.cwd);
    if (existing) {
      return this.updateAgent(existing.id, {
        name: opts.name,
        visibility: opts.visibility,
        tags: opts.tags,
        status: "active",
        pid: opts.pid,
      });
    }

    const id = this.peerId;
    const agent: AgentIdentity = {
      id,
      version: 1,
      name: opts.name,
      harness: opts.harness,
      cwd: opts.cwd,
      pid: opts.pid,
      startedAt: this.startedAt,
      visibility: opts.visibility,
      status: "active",
      tags: opts.tags,
      subscribedRooms: [],
    };

    this.agents.set(id, agent);
    await this.writeIdentity(opts.harness, opts.cwd, id);
    await this.broadcastPatch({ type: "agent_upsert", agent });
    // Broadcast presence to federated links
    if (agent.visibility === "visible") {
      await this.federation.broadcastAgentVisible(agent);
    }
    return agent;
  }

  async getAgent(id: string): Promise<AgentIdentity | undefined> {
    await Promise.resolve();
    return this.agents.get(id);
  }

  async updateAgent(
    id: string,
    patch: Partial<
      Pick<AgentIdentity, "name" | "visibility" | "status" | "tags" | "pid">
    >,
  ): Promise<AgentIdentity> {
    const agent = this.agents.get(id);
    if (!agent)
      throw new CommsError(`Agent ${id} not found`, "AGENT_NOT_FOUND");

    const oldStatus = agent.status;
    const oldName = agent.name;
    Object.assign(agent, patch);
    this.bump(agent);
    this.agents.set(id, agent);
    await this.broadcastPatch({ type: "agent_upsert", agent });

    if (patch.name !== undefined && patch.name !== oldName) {
      await this.notifyRoomsOfNameChange(id, oldName, patch.name);
    }

    if (patch.status && patch.status !== oldStatus) {
      await this.notifyRoomsOfStatus(id, patch.status);
    }

    return agent;
  }

  async listAgents(requesterId: string): Promise<AgentIdentity[]> {
    await Promise.resolve();
    const result: AgentIdentity[] = [];
    for (const agent of this.agents.values()) {
      if (agent.visibility === "ghost" && agent.id !== requesterId) continue;
      result.push(agent);
    }
    return result;
  }

  async setAgentOffline(id: string): Promise<void> {
    const agent = this.agents.get(id);
    if (!agent) return;
    if (agent.status === "offline") return;

    // Only the owning store should broadcast the status change.
    // Other stores learn about it via the agent_offline mesh patch.
    const isOwner = id === this.peerId;
    agent.status = "offline";
    this.bump(agent);
    this.agents.set(id, agent);

    if (isOwner) {
      await this.notifyRoomsOfStatus(id, "offline");
      await this.broadcastPatch({ type: "agent_offline", agentId: id });
      await this.federation.broadcastAgentGone(id);
    }
  }

  // -----------------------------------------------------------------------
  // CommsStore — Rooms
  // -----------------------------------------------------------------------

  async createRoom(opts: {
    name: string;
    type: RoomType;
    owner: string;
    description: string;
    federated?: boolean;
  }): Promise<Room> {
    // slugRoomName sanitises an arbitrary caller-supplied name (e.g. from a live create_room tool call, not just an internal cwd basename) into the room-path grammar's [A-Za-z0-9_-]+ charset -- createRoom is the one choke point every room creation goes through, so this is the right place to do it rather than trusting every caller to have pre-slugged, the way the old bare-name id never required at all.
    const slugName = slugRoomName(opts.name);
    const localName = opts.type === "secret" ? `_${slugName}` : slugName;
    const id = ownerNamedRoomPath(opts.owner, localName);
    if (this.rooms.has(id))
      throw new CommsError(`Room ${id} already exists`, "ROOM_EXISTS");

    const room: Room = {
      id,
      version: 1,
      name: slugName,
      type: opts.type,
      owner: opts.owner,
      createdAt: new Date().toISOString(),
      description: opts.description,
      members: [opts.owner],
      invited: [],
      memberJoins: { [opts.owner]: 1 },
      memberLeaves: {},
      invitedJoins: {},
      invitedLeaves: {},
      federated: opts.federated ?? false,
    };

    this.rooms.set(id, room);
    this.messages.set(id, []);
    await this.broadcastPatch({ type: "room_upsert", room });
    return room;
  }

  async getRoom(id: string): Promise<Room | undefined> {
    await Promise.resolve();
    return this.rooms.get(id);
  }

  async listRooms(requesterId: string): Promise<Room[]> {
    await Promise.resolve();
    const result: Room[] = [];
    for (const room of this.rooms.values()) {
      if (room.type === "secret" && !room.members.includes(requesterId))
        continue;
      result.push(room);
    }
    return result;
  }

  async joinRoom(roomId: string, agentId: string): Promise<Room> {
    const room = this.rooms.get(roomId);
    if (!room)
      throw new CommsError(`Room ${roomId} not found`, "ROOM_NOT_FOUND");

    const alreadyMember = room.members.includes(agentId);
    if (!alreadyMember && room.type !== "public") {
      if (!room.invited.includes(agentId) && room.owner !== agentId) {
        throw new CommsError(`Not invited to room ${roomId}`, "NOT_INVITED");
      }
    }

    this.bump(room);
    this.recordMemberOp(room, "member", "join", agentId);
    if (alreadyMember || room.type !== "public") {
      // Consuming an invitation (or re-joining) retires the invited entry.
      this.recordMemberOp(room, "invited", "leave", agentId);
    }
    this.refreshMembership(room);
    this.rooms.set(roomId, room);

    const agent = this.agents.get(agentId);
    if (agent && !agent.subscribedRooms.includes(roomId)) {
      agent.subscribedRooms.push(roomId);
      this.bump(agent);
      this.agents.set(agentId, agent);
      await this.broadcastPatch({ type: "agent_upsert", agent });
    }

    await this.broadcastPatch({ type: "room_upsert", room });

    // Send current member list to the joining agent
    const members: { id: string; name: string; status: AgentStatus }[] = [];
    for (const memberId of room.members) {
      const memberAgent = this.agents.get(memberId);
      if (memberAgent) {
        members.push({
          id: memberAgent.id,
          name: memberAgent.name,
          status: memberAgent.status,
        });
      }
    }
    await this.deliverLocallyAndBroadcast(agentId, {
      type: "room_members",
      room: roomId,
      members,
    });

    // Notify existing members of the join
    await this.deliverToRoom(
      roomId,
      {
        type: "member_joined",
        room: roomId,
        agent: agentId,
      },
      agentId,
    );

    // Notify federated links if the room is federated
    if (room.federated) {
      const agentName = agent?.name ?? agentId;
      await this.federation.broadcastRoomJoin(roomId, agentId, agentName);
    }

    return room;
  }

  async leaveRoom(roomId: string, agentId: string): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room)
      throw new CommsError(`Room ${roomId} not found`, "ROOM_NOT_FOUND");

    this.bump(room);
    this.recordMemberOp(room, "member", "leave", agentId);
    this.refreshMembership(room);
    this.rooms.set(roomId, room);

    const agent = this.agents.get(agentId);
    if (agent) {
      agent.subscribedRooms = agent.subscribedRooms.filter(
        (id) => id !== roomId,
      );
      this.agents.set(agentId, agent);
      await this.broadcastPatch({ type: "agent_upsert", agent });
    }

    await this.broadcastPatch({ type: "room_upsert", room });
    await this.deliverToRoom(roomId, {
      type: "member_left",
      room: roomId,
      agent: agentId,
    });

    // Notify federated links if the room is federated
    if (room.federated) {
      await this.federation.broadcastRoomLeave(roomId, agentId);
    }

    if (room.members.length === 0 && room.owner === agentId) {
      await this.destroyRoom(roomId, agentId);
    }
  }

  async inviteToRoom(
    roomId: string,
    targetId: string,
    inviterId: string,
  ): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room)
      throw new CommsError(`Room ${roomId} not found`, "ROOM_NOT_FOUND");
    if (room.owner !== inviterId)
      throw new CommsError("Only the room owner can invite", "NOT_OWNER");

    this.bump(room);
    if (!room.invited.includes(targetId) && !room.members.includes(targetId)) {
      this.recordMemberOp(room, "invited", "join", targetId);
    }
    this.refreshMembership(room);
    this.rooms.set(roomId, room);
    await this.broadcastPatch({ type: "room_upsert", room });

    const inviter = this.agents.get(inviterId);
    await this.deliverLocallyAndBroadcast(targetId, {
      type: "room_invite",
      room: roomId,
      roomDescription: room.description,
      from: inviterId,
      fromName: inviter?.name ?? inviterId,
      fromCwd: inviter?.cwd ?? "",
    });
  }

  async declineInvite(
    roomId: string,
    agentId: string,
    reason: string,
  ): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room)
      throw new CommsError(`Room ${roomId} not found`, "ROOM_NOT_FOUND");

    if (!room.invited.includes(agentId))
      throw new CommsError(
        `Agent ${agentId} was not invited to ${roomId}`,
        "NOT_INVITED",
      );

    this.bump(room);
    this.recordMemberOp(room, "invited", "leave", agentId);
    this.refreshMembership(room);
    this.rooms.set(roomId, room);
    await this.broadcastPatch({ type: "room_upsert", room });

    const decliner = this.agents.get(agentId);
    await this.deliverLocallyAndBroadcast(room.owner, {
      type: "invite_declined",
      room: roomId,
      agent: agentId,
      agentName: decliner?.name ?? agentId,
      reason,
    });
  }

  async kickFromRoom(
    roomId: string,
    targetId: string,
    kickerId: string,
  ): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room)
      throw new CommsError(`Room ${roomId} not found`, "ROOM_NOT_FOUND");
    if (room.owner !== kickerId)
      throw new CommsError("Only the room owner can kick", "NOT_OWNER");

    this.bump(room);
    this.recordMemberOp(room, "member", "leave", targetId);
    this.recordMemberOp(room, "invited", "leave", targetId);
    this.refreshMembership(room);
    this.rooms.set(roomId, room);
    await this.broadcastPatch({ type: "room_upsert", room });
  }

  async destroyRoom(roomId: string, agentId: string): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room)
      throw new CommsError(`Room ${roomId} not found`, "ROOM_NOT_FOUND");
    if (room.owner !== agentId)
      throw new CommsError("Only the room owner can destroy", "NOT_OWNER");

    for (const memberId of room.members) {
      const member = this.agents.get(memberId);
      if (member) {
        member.subscribedRooms = member.subscribedRooms.filter(
          (id) => id !== roomId,
        );
        this.agents.set(memberId, member);
        await this.broadcastPatch({ type: "agent_upsert", agent: member });
      }
    }

    this.rooms.delete(roomId);
    this.messages.delete(roomId);
    await this.broadcastPatch({ type: "room_delete", roomId });
  }

  // -----------------------------------------------------------------------
  // CommsStore — Messages
  // -----------------------------------------------------------------------

  async sendRoomMessage(
    roomId: string,
    from: string,
    content: string,
    replyTo?: string,
    streamingBehavior?: StreamingBehavior,
  ): Promise<RoomMessage> {
    const room = this.rooms.get(roomId);
    if (!room)
      throw new CommsError(`Room ${roomId} not found`, "ROOM_NOT_FOUND");
    if (!room.members.includes(from))
      throw new CommsError(`Not a member of ${roomId}`, "NOT_MEMBER");

    const id = `${String(Date.now())}-${nanoid(6)}`;
    const message: RoomMessage = {
      id,
      from,
      room: roomId,
      content,
      timestamp: new Date().toISOString(),
      replyTo,
      readBy: [from],
      ...(streamingBehavior !== undefined && { streamingBehavior }),
    };

    const arr = this.messages.get(roomId) ?? [];
    arr.push(message);
    this.messages.set(roomId, arr);
    await this.broadcastPatch({ type: "message_add", roomId, message });

    // Forward to federated links if the room is federated
    if (room.federated) {
      await this.federation.forwardRoomMessage(roomId, message);
    }

    for (const memberId of room.members) {
      if (memberId !== from) {
        await this.deliverLocallyAndBroadcast(memberId, {
          type: "room_message",
          message,
        });
      }
    }

    return message;
  }

  async readRoomMessages(
    roomId: string,
    since?: string,
  ): Promise<RoomMessage[]> {
    await Promise.resolve();
    const arr = this.messages.get(roomId) ?? [];
    if (!since) return [...arr];
    return arr.filter((m) => m.timestamp > since);
  }

  // -----------------------------------------------------------------------
  // CommsStore — DMs
  // -----------------------------------------------------------------------

  async sendDm(
    from: string,
    to: string,
    content: string,
    streamingBehavior?: StreamingBehavior,
  ): Promise<DmMessage> {
    if (to !== from) {
      const recipient = this.agents.get(to);
      if (!recipient)
        throw new CommsError(`Agent ${to} not found`, "AGENT_NOT_FOUND");
      if (recipient.visibility === "ghost")
        throw new CommsError(`Cannot DM agent ${to}`, "AGENT_NOT_FOUND");
    }

    const id = `${String(Date.now())}-${nanoid(6)}`;
    const message: DmMessage = {
      id,
      from,
      to,
      content,
      timestamp: new Date().toISOString(),
      readBy: [from],
      ...(streamingBehavior !== undefined && { streamingBehavior }),
    };

    // Self-DM is a purely local scratchpad note -- it never leaves the process, so it needs no room-path and dmRoomPath's own a===b refusal (a path naming the same device twice is not a valid DM path at all) correctly does not apply here.
    const key = to === from ? `self:${from}` : dmRoomPath(from, to);
    const arr = this.dms.get(key) ?? [];
    arr.push(message);
    this.dms.set(key, arr);
    await this.broadcastPatch({ type: "dm_add", key, message });

    await this.deliverLocallyAndBroadcast(to, { type: "dm", message });
    return message;
  }

  // -----------------------------------------------------------------------
  // CommsStore — Delivery
  // -----------------------------------------------------------------------

  async deliver(agentId: string, event: DeliveryEvent): Promise<void> {
    await this.deliverLocallyAndBroadcast(agentId, event);
  }

  async drainDelivery(agentId: string): Promise<DeliveryEvent[]> {
    await Promise.resolve();
    const events = this.deliveryQueues.get(agentId) ?? [];
    this.deliveryQueues.set(agentId, []);

    // Auto-mark messages as read — drain bridges consume on tool call
    for (const event of events) {
      if (event.type === "room_message") {
        await this.markRead(event.message.id, agentId, event.message.room);
      } else if (event.type === "dm") {
        await this.markRead(event.message.id, agentId);
      }
    }

    return events;
  }

  // -----------------------------------------------------------------------
  // Stale agent cleanup (coordinator only)
  // -----------------------------------------------------------------------

  private startStaleCheck(): void {
    if (this.staleCheckTimer) return;
    this.staleCheckTimer = setInterval(() => {
      void this.probeStaleAgents();
    }, 5000);
  }

  private stopStaleCheck(): void {
    if (this.staleCheckTimer) {
      clearInterval(this.staleCheckTimer);
      this.staleCheckTimer = undefined;
    }
  }

  private async probeStaleAgents(): Promise<void> {
    const deadIds: string[] = [];

    for (const [id, agent] of this.agents) {
      if (agent.status !== "active") continue;
      if (!this.isProcessAlive(agent.pid)) {
        deadIds.push(id);
      }
    }

    for (const id of deadIds) {
      const agent = this.agents.get(id);
      if (agent) {
        agent.status = "offline";
        this.agents.set(id, agent);
        await this.notifyRoomsOfStatus(id, "offline");
      }
      await this.broadcastPatch({ type: "agent_offline", agentId: id });
      this.peerInfo.delete(id);
    }

    // Also purge long-offline agents to prevent indefinite accumulation
    const offlineThreshold = Date.now() - 30 * 60 * 1000; // 30 minutes
    const purgeIds: string[] = [];
    for (const [id, agent] of this.agents) {
      if (agent.status !== "offline") continue;
      const startedAt = new Date(agent.startedAt).getTime();
      if (startedAt < offlineThreshold) {
        purgeIds.push(id);
      }
    }
    for (const id of purgeIds) {
      this.agents.delete(id);
      this.peerInfo.delete(id);
      this.identityCache.delete(id);
      this.deliveryQueues.delete(id);
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Mesh visibility
  // -----------------------------------------------------------------------

  /** Set mesh discovery visibility. Delegates to discovery manager. */
  async setVisibility(level: MeshVisibility, adapter?: string): Promise<void> {
    await this.discovery.setVisibility(level, adapter);
  }

  /** Get current mesh discovery visibility. */
  getVisibility(adapter?: string): MeshVisibility {
    return this.discovery.getVisibility(adapter);
  }

  // -----------------------------------------------------------------------
  // Listener management (coordinator only)
  // -----------------------------------------------------------------------

  async addListener(
    host: string,
    port: number,
    policy: string,
  ): Promise<string> {
    function isListenerPolicy(v: string): v is ListenerPolicy {
      return (
        v === "full" || v === "observe" || v === "rooms-only" || v === "gateway"
      );
    }
    if (!isListenerPolicy(policy)) {
      throw new CommsError(`Invalid policy "${policy}"`, "INVALID_POLICY");
    }
    return this.requireTransport().addListener(host, port, policy);
  }

  async removeListener(id: string): Promise<void> {
    return this.requireTransport().removeListener(id);
  }

  listListeners(): ListenerInfo[] {
    return this.requireTransport().listListeners();
  }

  getNetworkInterfaces(): NetworkInterface[] {
    const interfaces = os.networkInterfaces();
    const result: NetworkInterface[] = [];
    for (const [name, addrs] of Object.entries(interfaces)) {
      if (addrs === undefined) continue;
      for (const addr of addrs) {
        result.push({
          name,
          address: addr.address,
          family: addr.family,
          internal: addr.internal,
        });
      }
    }
    return result;
  }

  // -----------------------------------------------------------------------
  // Federation (coordinator-to-coordinator)
  // -----------------------------------------------------------------------

  async fedConnect(host: string, port: number, name?: string): Promise<string> {
    return this.federation.connect(host, port, name);
  }

  async fedDisconnect(linkId: string): Promise<void> {
    await this.federation.disconnect(linkId);
  }

  fedLinks(): FedLink[] {
    return this.federation.listLinks();
  }

  getFederationFingerprint(): string {
    return getCertificateFingerprint(this.federation.tlsIdentity.certificate);
  }

  fedTrust(fingerprint: string): Promise<void> {
    this.federation.addTrustedFingerprint(fingerprint);
    return Promise.resolve();
  }

  fedUntrust(fingerprint: string): Promise<void> {
    this.federation.removeTrustedFingerprint(fingerprint);
    return Promise.resolve();
  }

  fedTrustedFingerprints(): string[] {
    return this.federation.listTrustedFingerprints();
  }

  fedListen(host: string, port: number): Promise<void> {
    return this.federation.listen(host, port);
  }

  fedStopListening(): Promise<void> {
    return this.federation.stopListening();
  }

  // -----------------------------------------------------------------------
  // Federation callbacks (inbound from remote meshes)
  // -----------------------------------------------------------------------

  private async handleFedAgentVisible(agent: AgentIdentity): Promise<void> {
    // Store remote agent with a prefixed ID to avoid collisions with local agents
    const remoteId = `fed:${agent.id}@${agent.harness}`;
    const remoteAgent: AgentIdentity = {
      ...agent,
      id: remoteId,
      tags: [...agent.tags, "federated"],
    };
    this.agents.set(remoteId, remoteAgent);
    await this.broadcastPatch({ type: "agent_upsert", agent: remoteAgent });
  }

  private async handleFedAgentGone(agentId: string): Promise<void> {
    // The agentId comes from the remote mesh — we need to find the prefixed version
    const prefix = `fed:${agentId}@`;
    for (const [localId, agent] of this.agents) {
      if (localId.startsWith(prefix)) {
        agent.status = "offline";
        this.agents.set(localId, agent);
        await this.broadcastPatch({ type: "agent_offline", agentId: localId });
        break;
      }
    }
  }

  private async handleFedRoomMessage(
    roomId: string,
    message: RoomMessage,
  ): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room?.federated) return;

    // Store the message locally
    const arr = this.messages.get(roomId) ?? [];
    arr.push(message);
    this.messages.set(roomId, arr);

    // Deliver to all local room members
    for (const memberId of room.members) {
      await this.deliverLocallyAndBroadcast(memberId, {
        type: "room_message",
        message,
      });
    }
  }

  private async handleFedRoomJoin(
    roomId: string,
    agentId: string,
    _agentName: string,
  ): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room?.federated) return;

    // Create a shadow agent ID for the remote agent
    const remoteId = `fed:${agentId}`;

    if (!room.members.includes(remoteId)) {
      this.bump(room);
      this.recordMemberOp(room, "member", "join", remoteId);
      this.refreshMembership(room);
      this.rooms.set(roomId, room);
      await this.broadcastPatch({ type: "room_upsert", room });
    }

    // Notify local members
    await this.deliverToRoom(
      roomId,
      {
        type: "member_joined",
        room: roomId,
        agent: remoteId,
      },
      remoteId,
    );
  }

  private async handleFedRoomLeave(
    roomId: string,
    agentId: string,
  ): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room?.federated) return;

    const remoteId = `fed:${agentId}`;
    this.bump(room);
    this.recordMemberOp(room, "member", "leave", remoteId);
    this.refreshMembership(room);
    this.rooms.set(roomId, room);
    await this.broadcastPatch({ type: "room_upsert", room });

    await this.deliverToRoom(roomId, {
      type: "member_left",
      room: roomId,
      agent: remoteId,
    });
  }

  private getVisibleAgentsForFed(): AgentIdentity[] {
    const result: AgentIdentity[] = [];
    for (const agent of this.agents.values()) {
      // Only broadcast agents that belong to this mesh (not federated)
      // and are visible
      if (agent.visibility === "visible" && !agent.id.startsWith("fed:")) {
        result.push(agent);
      }
    }
    return result;
  }

  private getFederatedRoomMembershipsForFed(): Map<string, string[]> {
    const result = new Map<string, string[]>();
    for (const [roomId, room] of this.rooms) {
      if (room.federated) {
        // Only include local members (not federated ones)
        const localMembers = room.members.filter((m) => !m.startsWith("fed:"));
        result.set(roomId, localMembers);
      }
    }
    return result;
  }

  // -----------------------------------------------------------------------
  // Shutdown
  // -----------------------------------------------------------------------

  async shutdown(): Promise<void> {
    this.isShutDown = true;
    // Clear any pending markRead timers so they don't fire after the
    // transport is shut down (which would attempt sends on closed sockets)
    // or keep the event loop alive after process.exit().
    for (const timer of this.pendingMarkReadTimers) {
      clearTimeout(timer);
    }
    this.pendingMarkReadTimers.length = 0;

    const agent = this.agents.get(this.peerId);
    if (agent) {
      agent.status = "offline";
      await this.broadcastPatch({
        type: "agent_offline",
        agentId: this.peerId,
      });
    }

    this.stopStaleCheck();
    await this.federation.shutdown();
    await this.requireTransport().shutdown();
  }
}

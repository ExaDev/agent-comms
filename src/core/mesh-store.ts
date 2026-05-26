/**
 * MeshStore — transport-agnostic peer mesh for agent communication.
 *
 * Each bridge instance is a peer in the mesh. Peers discover each other
 * via a coordinator (the first instance to bind the well-known port).
 * All state is held in memory and synchronised between peers.
 * Delivery events are pushed directly over the transport — no polling,
 * no filesystem.
 *
 * Transport is injected via the constructor. TcpTransport for localhost
 * TCP, TlsTransport for encrypted connections, etc.
 */

import * as os from "node:os";
import { nanoid } from "./nanoid.js";
import { CommsError } from "./store.js";
import { TcpTransport } from "./tcp-transport.js";
import { dmKey } from "./wire-protocol.js";
import { DiscoveryManager } from "./discovery.js";
import { MdnsDiscoveryBackend } from "./discovery-mdns.js";
import { TailscaleDiscoveryBackend } from "./discovery-tailscale.js";
import { FederationManager } from "./federation.js";
import type { FedLink } from "./federation.js";
import type {
  MeshMessage,
  MeshStatePatch,
  PeerInfo,
  SerialisedState,
} from "./wire-protocol.js";
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
  NetworkInterface,
  Room,
  RoomMessage,
  RoomType,
  Visibility,
} from "./types.js";
import type { ListenerInfo } from "./transport.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_COORDINATOR_PORT = 19876;
const COORDINATOR_HOST = "127.0.0.1";

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

  private transport: MeshTransport;
  private peerInfo = new Map<string, PeerInfo>();
  private staleCheckTimer: ReturnType<typeof setInterval> | undefined;
  private isShutDown = false;
  private pendingMarkReadTimers: ReturnType<typeof setTimeout>[] = [];

  // -- Pending inbound connections awaiting approval --
  private pendingInboundConnections = new Map<
    string,
    { peerId: string; dataPort: number; name: string; fingerprint: string }
  >();

  onDelivery:
    | ((agentId: string, event: DeliveryEvent) => void | Promise<void>)
    | undefined;

  /** Fires for every state patch — both locally generated and remote. */
  onPatch:
    | ((patch: MeshStatePatch) => void | Promise<void>)
    | undefined;

  private lastLocalDeliveryKey: string | undefined;
  private localDeliveryKeys = new Set<string>();

  discovery: DiscoveryManager;
  federation: FederationManager;

  constructor(coordinatorPort: number = DEFAULT_COORDINATOR_PORT) {
    this.peerId = nanoid(8);
    this.startedAt = new Date().toISOString();
    this.coordinatorPort = coordinatorPort;
    // Wire up transport with this store's event handlers.
    // TcpTransport is the default; callers can replace via setTransport().
    this.transport = new TcpTransport(this.events);

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
        onRoomMessage: (roomId, message) => this.handleFedRoomMessage(roomId, message),
        onRoomJoin: (roomId, agentId, agentName) => this.handleFedRoomJoin(roomId, agentId, agentName),
        onRoomLeave: (roomId, agentId) => this.handleFedRoomLeave(roomId, agentId),
        getVisibleAgents: () => this.getVisibleAgentsForFed(),
        getFederatedRoomMemberships: () => this.getFederatedRoomMembershipsForFed(),
      },
    );
  }

  /** Replace the transport (e.g. with TlsTransport for encrypted connections). */
  setTransport(transport: MeshTransport): void {
    this.transport = transport;
  }

  // -----------------------------------------------------------------------
  // Mesh lifecycle
  // -----------------------------------------------------------------------

  async init(): Promise<void> {
    await this.transport.startDataServer();

    // Register our own peer info
    this.peerInfo.set(this.peerId, {
      id: this.peerId,
      port: this.transport.dataPort,
      startedAt: this.startedAt,
    });

    // Try joining an existing mesh; fall back to becoming coordinator.
    // If becomeCoordinator fails with EADDRINUSE (another process won the race),
    // retry connecting — the new coordinator should be ready by now.
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 200;
    let connected = false;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        await this.transport.connectToCoordinator(
          COORDINATOR_HOST,
          this.coordinatorPort,
          this.peerId,
          this.transport.dataPort,
        );
        connected = true;
        break;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // Only try to become coordinator on the first attempt
        if (attempt === 0) {
          try {
            await this.transport.becomeCoordinator(
              COORDINATOR_HOST,
              this.coordinatorPort,
            );
            this.startStaleCheck();
            connected = true;
            break;
          } catch (coordErr) {
            const msg = coordErr instanceof Error ? coordErr.message : String(coordErr);
            if (!msg.includes("EADDRINUSE")) {
              throw coordErr;
            }
            // EADDRINUSE — another process became coordinator. Retry connect.
          }
        }
        // Wait before retrying
        if (attempt < MAX_RETRIES - 1) {
          await new Promise<void>((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        }
      }
    }

    if (!connected) {
      throw new Error(
        `Failed to join or create mesh on port ${String(this.coordinatorPort)}: ${lastError?.message ?? "unknown error"}`,
      );
    }

    this.transport.unref();
  }

  // -----------------------------------------------------------------------
  // TransportEvents — callbacks from the transport layer
  // -----------------------------------------------------------------------

  private handlePeerList(peers: PeerInfo[]): void {
    for (const peer of peers) {
      this.peerInfo.set(peer.id, peer);
      void this.transport.connectToPeer(peer, this.peerId);
    }
  }

  private handlePeerJoined(peer: PeerInfo): void {
    this.peerInfo.set(peer.id, peer);
    void this.transport.connectToPeer(peer, this.peerId);
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
    await this.transport.send(handle, peerList);

    // Broadcast arrival to all existing peers
    const joined: MeshMessage = { method: "peer_joined", peer: newPeer };
    await this.transport.broadcast(joined);

    // Connect to the new peer's data server
    void this.transport.connectToPeer(newPeer, this.peerId);
  }

  private async handlePeerConnected(
    handle: ConnectionHandle,
    info: PeerInfo,
  ): Promise<void> {
    // If we have state and the peer doesn't, send state sync
    if (this.agents.size > 0) {
      const state: SerialisedState = {
        agents: Object.fromEntries(this.agents),
        rooms: Object.fromEntries(this.rooms),
        messages: Object.fromEntries(this.messages),
        dms: Object.fromEntries(this.dms),
      };
      await this.transport.send(handle, {
        method: "state_sync",
        state,
      });
    }
  }

  private async handleDataMessage(
    handle: ConnectionHandle,
    msg: MeshMessage,
  ): Promise<void> {
    if (msg.method === "state_sync") {
      // Merge — don't replace — so our own state isn't lost
      const incoming = {
        agents: new Map(Object.entries(msg.state.agents)),
        rooms: new Map(Object.entries(msg.state.rooms)),
        messages: new Map(Object.entries(msg.state.messages)),
        dms: new Map(Object.entries(msg.state.dms)),
      };
      for (const [id, agent] of incoming.agents) {
        if (!this.agents.has(id)) this.agents.set(id, agent);
      }
      for (const [id, room] of incoming.rooms) {
        if (!this.rooms.has(id)) this.rooms.set(id, room);
      }
      for (const [id, msgs] of incoming.messages) {
        if (!this.messages.has(id)) this.messages.set(id, msgs);
      }
      for (const [id, dmMsgs] of incoming.dms) {
        if (!this.dms.has(id)) this.dms.set(id, dmMsgs);
      }
    } else if (msg.method === "state_update") {
      await this.applyPatch(msg.patch);
    }
  }

  private async handleBecomeCoordinator(
    peerList: PeerInfo[],
  ): Promise<void> {
    // Take over as coordinator using the data server we already have
    await this.transport.becomeCoordinator(
      COORDINATOR_HOST,
      this.coordinatorPort,
    );
    this.peerInfo.clear();
    for (const peer of peerList) {
      this.peerInfo.set(peer.id, peer);
      void this.transport.connectToPeer(peer, this.peerId);
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
    request: { peerId: string; dataPort: number; name: string; fingerprint: string },
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
    const arr = this.deliveryQueues.get(this.peerId) ?? [];
    arr.push(event);
    this.deliveryQueues.set(this.peerId, arr);
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
    await this.transport.acceptConnection(handle);
  }

  /** Reject a pending inbound connection. */
  async rejectConnection(connectionId: string, reason: string): Promise<void> {
    const pending = this.pendingInboundConnections.get(connectionId);
    if (!pending) {
      throw new Error(`No pending connection ${connectionId}`);
    }
    this.pendingInboundConnections.delete(connectionId);
    const handle: ConnectionHandle = { id: connectionId };
    await this.transport.rejectConnection(handle, reason);
  }

  /** List all pending inbound connections awaiting approval. */
  listPendingConnections(): Array<{
    connectionId: string;
    peerId: string;
    dataPort: number;
    name: string;
    fingerprint: string;
  }> {
    return [...this.pendingInboundConnections.entries()].map(
      ([id, info]) => ({ connectionId: id, ...info }),
    );
  }

  /** Initiate an outbound connection to a remote coordinator requiring approval.
   *  Fires the connect_request and returns immediately. The connection
   *  completes asynchronously when the coordinator accepts or rejects. */
  async connectToRemote(host: string, port: number): Promise<void> {
    const agent = this.agents.get(this.peerId);
    // Fire-and-forget: don't await the full approval handshake.
    // The coordinator will either accept (triggering normal introduction flow)
    // or reject (closing the socket). Handle rejection to avoid unhandled rejection.
    this.transport.connectToRemote(
      host,
      port,
      this.peerId,
      this.transport.dataPort,
      agent?.name ?? "",
      "",
    ).catch((err: unknown) => {
      // Rejection is expected when the coordinator denies the connection.
      // Log silently — the calling tool already returned success.
      void err;
    });
  }

  /** Start only the data server without connecting to a coordinator.
   *  Used for testing scenarios where the peer connects via connectToRemote. */
  async startDataServerOnly(): Promise<void> {
    await this.transport.startDataServer();
    this.peerInfo.set(this.peerId, {
      id: this.peerId,
      port: this.transport.dataPort,
      startedAt: this.startedAt,
    });
    this.transport.unref();
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
    };
  }

  // -----------------------------------------------------------------------
  // State patch application
  // -----------------------------------------------------------------------

  private async applyPatch(patch: MeshStatePatch): Promise<void> {
    switch (patch.type) {
      case "agent_upsert": {
        // Merge subscribedRooms to avoid losing local room memberships.
        const existingAgent = this.agents.get(patch.agent.id);
        if (existingAgent) {
          const merged = patch.agent;
          for (const r of existingAgent.subscribedRooms) {
            if (!merged.subscribedRooms.includes(r))
              merged.subscribedRooms.push(r);
          }
          this.agents.set(merged.id, merged);
        } else {
          this.agents.set(patch.agent.id, patch.agent);
        }
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
        // Merge members rather than overwriting — last-write-wins can lose
        // members added locally when a remote patch arrives with a stale list.
        const existing = this.rooms.get(patch.room.id);
        if (existing) {
          const merged = patch.room;
          for (const m of existing.members) {
            if (!merged.members.includes(m)) merged.members.push(m);
          }
          this.rooms.set(merged.id, merged);
        } else {
          this.rooms.set(patch.room.id, patch.room);
        }
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
        const arr = this.deliveryQueues.get(patch.agentId) ?? [];
        arr.push(patch.event);
        this.deliveryQueues.set(patch.agentId, arr);
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
    await this.transport.broadcast({ method: "state_update", patch });
    if (this.onPatch) {
      await this.onPatch(patch);
    }
  }

  private async deliverLocallyAndBroadcast(
    agentId: string,
    event: DeliveryEvent,
  ): Promise<void> {
    // Local delivery
    const arr = this.deliveryQueues.get(agentId) ?? [];
    arr.push(event);
    this.deliveryQueues.set(agentId, arr);

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

    if (agentId === this.peerId && this.onDelivery) {
      // Deduplicate: skip if this exact event was already delivered locally.
      // The mesh can echo delivery patches through multiple peer paths,
      // causing applyPatch to fire onDelivery for the same event.
      const eventKey = JSON.stringify(event);
      if (this.localDeliveryKeys.has(eventKey)) return;
      this.localDeliveryKeys.add(eventKey);
      // Prevent unbounded growth — evict oldest when cap reached
      if (this.localDeliveryKeys.size > 50) {
        const oldest = this.localDeliveryKeys.values().next().value;
        if (oldest !== undefined) this.localDeliveryKeys.delete(oldest);
      }
      void this.onDelivery(agentId, event);
      // Auto-mark read — scheduled as a macrotask to yield to the event
      // loop (see matching comment in applyPatch for rationale).
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

    // Remote delivery
    const patch: MeshStatePatch = { type: "delivery", agentId, event };
    await this.broadcastPatch(patch);
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
    const id = opts.type === "secret" ? `_${opts.name}` : opts.name;
    if (this.rooms.has(id))
      throw new CommsError(`Room ${id} already exists`, "ROOM_EXISTS");

    const room: Room = {
      id,
      name: opts.name,
      type: opts.type,
      owner: opts.owner,
      createdAt: new Date().toISOString(),
      description: opts.description,
      members: [opts.owner],
      invited: [],
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

    if (room.type === "public") {
      if (!room.members.includes(agentId)) room.members.push(agentId);
    } else {
      if (
        !room.invited.includes(agentId) &&
        room.owner !== agentId &&
        !room.members.includes(agentId)
      ) {
        throw new CommsError(`Not invited to room ${roomId}`, "NOT_INVITED");
      }
      room.invited = room.invited.filter((id) => id !== agentId);
      if (!room.members.includes(agentId)) room.members.push(agentId);
    }

    this.rooms.set(roomId, room);

    const agent = this.agents.get(agentId);
    if (agent && !agent.subscribedRooms.includes(roomId)) {
      agent.subscribedRooms.push(roomId);
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

    room.members = room.members.filter((id) => id !== agentId);
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

    if (!room.invited.includes(targetId) && !room.members.includes(targetId)) {
      room.invited.push(targetId);
    }
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

    room.invited = room.invited.filter((id) => id !== agentId);
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

    room.members = room.members.filter((id) => id !== targetId);
    room.invited = room.invited.filter((id) => id !== targetId);
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

  async sendDm(from: string, to: string, content: string): Promise<DmMessage> {
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
    };

    const key = dmKey(from, to);
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
  async setVisibility(
    level: import("./types.js").MeshVisibility,
    adapter?: string,
  ): Promise<void> {
    await this.discovery.setVisibility(level, adapter);
  }

  /** Get current mesh discovery visibility. */
  getVisibility(adapter?: string): import("./types.js").MeshVisibility {
    return this.discovery.getVisibility(adapter);
  }

  // -----------------------------------------------------------------------
  // Listener management (coordinator only)
  // -----------------------------------------------------------------------

  async addListener(host: string, port: number, policy: string): Promise<string> {
    const validPolicies: string[] = ["full", "observe", "rooms-only", "gateway"];
    if (!validPolicies.includes(policy)) {
      throw new CommsError(
        `Invalid policy "${policy}"`, 
        "INVALID_POLICY",
      );
    }
    return this.transport.addListener(host, port, policy as "full" | "observe" | "rooms-only" | "gateway");
  }

  async removeListener(id: string): Promise<void> {
    return this.transport.removeListener(id);
  }

  listListeners(): ListenerInfo[] {
    return this.transport.listListeners();
  }

  getNetworkInterfaces(): NetworkInterface[] {
    const interfaces = os.networkInterfaces();
    const result: NetworkInterface[] = [];
    for (const [name, addrs] of Object.entries(interfaces)) {
      if (addrs === undefined) continue;
      for (const addr of addrs) {
        if (addr.family === "IPv4" || addr.family === "IPv6") {
          result.push({
            name,
            address: addr.address,
            family: addr.family,
            internal: addr.internal,
          });
        }
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

  private async handleFedRoomMessage(roomId: string, message: RoomMessage): Promise<void> {
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

  private async handleFedRoomJoin(roomId: string, agentId: string, agentName: string): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room?.federated) return;

    // Create a shadow agent ID for the remote agent
    const remoteId = `fed:${agentId}`;

    if (!room.members.includes(remoteId)) {
      room.members.push(remoteId);
      this.rooms.set(roomId, room);
      await this.broadcastPatch({ type: "room_upsert", room });
    }

    // Notify local members
    await this.deliverToRoom(roomId, {
      type: "member_joined",
      room: roomId,
      agent: remoteId,
    }, remoteId);
  }

  private async handleFedRoomLeave(roomId: string, agentId: string): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room?.federated) return;

    const remoteId = `fed:${agentId}`;
    room.members = room.members.filter((m) => m !== remoteId);
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
    await this.transport.shutdown();
  }
}

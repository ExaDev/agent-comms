/**
 * MeshStore — TCP localhost peer mesh for agent communication.
 *
 * Each bridge instance is a peer in the mesh. Peers discover each other
 * via a coordinator (the first instance to bind the well-known port).
 * All state is held in memory and synchronised between peers.
 * Delivery events are pushed directly over TCP — no polling, no filesystem.
 *
 * Falls back to FileStore if the mesh is unavailable.
 */

import * as net from "node:net";
import { nanoid } from "./nanoid.js";
import { CommsError } from "./store.js";
import type { CommsStore } from "./comms-store.js";
import type {
  AgentIdentity,
  AgentStatus,
  DeliveryEvent,
  DeliveryStatus,
  DmMessage,
  Room,
  RoomMessage,
  RoomType,
  Visibility,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_COORDINATOR_PORT = 19876;
const COORDINATOR_HOST = "127.0.0.1";

// ---------------------------------------------------------------------------
// Wire protocol types
// ---------------------------------------------------------------------------

type MeshMessage =
  | { method: "state_sync"; state: SerialisedState }
  | { method: "state_update"; patch: MeshStatePatch }
  | { method: "introduce"; peerId: string; dataPort: number }
  | { method: "peer_list"; peers: PeerInfo[] }
  | { method: "peer_joined"; peer: PeerInfo }
  | { method: "peer_left"; peerId: string }
  | { method: "become_coordinator"; peerList: PeerInfo[] }
  | { method: "pong"; peerId: string };

interface PeerInfo {
  id: string;
  port: number;
  startedAt: string;
}

/** JSON-serialisable mesh state — Maps converted to plain objects. */
interface SerialisedState {
  agents: Record<string, AgentIdentity>;
  rooms: Record<string, Room>;
  messages: Record<string, RoomMessage[]>;
  dms: Record<string, DmMessage[]>;
}

type MeshStatePatch =
  | { type: "agent_upsert"; agent: AgentIdentity }
  | { type: "agent_offline"; agentId: string }
  | { type: "room_upsert"; room: Room }
  | { type: "room_delete"; roomId: string }
  | { type: "message_add"; roomId: string; message: RoomMessage }
  | { type: "dm_add"; key: string; message: DmMessage }
  | { type: "delivery"; agentId: string; event: DeliveryEvent }
  | { type: "message_read"; messageId: string; readBy: string; room?: string };

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

function encode(msg: MeshMessage): string {
  return JSON.stringify(msg) + "\n";
}

class MessageBuffer {
  private buffer = "";

  append(data: string): unknown[] {
    this.buffer += data;
    const results: unknown[] = [];
    let idx = this.buffer.indexOf("\n");
    while (idx !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length > 0) {
        try {
          results.push(JSON.parse(line));
        } catch {
          /* skip malformed lines */
        }
      }
      idx = this.buffer.indexOf("\n");
    }
    return results;
  }
}

function isMeshMessage(value: unknown): value is MeshMessage {
  if (typeof value !== "object" || value === null) return false;
  if (!("method" in value)) return false;
  return typeof value.method === "string";
}

function dmKey(a: string, b: string): string {
  const sorted = [a, b].sort();
  return `${sorted[0] ?? a}--${sorted[1] ?? b}`;
}

// ---------------------------------------------------------------------------
// Async socket write
// ---------------------------------------------------------------------------

function writeAsync(socket: net.Socket, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.destroyed) {
      resolve();
      return;
    }
    socket.write(data, "utf-8", (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// MeshStore
// ---------------------------------------------------------------------------

export class MeshStore implements CommsStore {
  readonly peerId: string;
  readonly startedAt: string;
  readonly coordinatorPort: number;

  private agents = new Map<string, AgentIdentity>();
  private rooms = new Map<string, Room>();
  private messages = new Map<string, RoomMessage[]>();
  private dms = new Map<string, DmMessage[]>();
  private deliveryQueues = new Map<string, DeliveryEvent[]>();
  private identityCache = new Map<string, { id: string }>();

  private dataServer: net.Server | undefined;
  private dataPort = 0;
  private coordinatorServer: net.Server | undefined;
  private isCoordinator = false;
  private peerConnections = new Map<
    string,
    { socket: net.Socket; buffer: MessageBuffer }
  >();
  /** All sockets accepted by the data server — destroyed on shutdown. */
  private dataServerSockets = new Set<net.Socket>();
  /** All sockets accepted by the coordinator server — destroyed on shutdown. */
  private coordinatorServerSockets = new Set<net.Socket>();
  /** Socket connected to the coordinator (client side) — destroyed on shutdown. */
  private coordinatorSocket: net.Socket | undefined;
  private peerInfo = new Map<string, PeerInfo>();
  private staleCheckTimer: ReturnType<typeof setInterval> | undefined;
  private isShutDown = false;
  private pendingMarkReadTimers: ReturnType<typeof setTimeout>[] = [];

  onDelivery:
    | ((agentId: string, event: DeliveryEvent) => void | Promise<void>)
    | undefined;
  private lastLocalDeliveryKey: string | undefined;
  private localDeliveryKeys = new Set<string>();

  constructor(coordinatorPort: number = DEFAULT_COORDINATOR_PORT) {
    this.peerId = nanoid(8);
    this.startedAt = new Date().toISOString();
    this.coordinatorPort = coordinatorPort;
  }

  // -----------------------------------------------------------------------
  // Mesh lifecycle
  // -----------------------------------------------------------------------

  async init(): Promise<void> {
    await this.startDataServer();
    await this.tryJoinMesh();
    // Unref all root handles so the event loop can exit when pi shuts down.
    // Sockets/servers still function normally for I/O but don't keep the
    // process alive. shutdown() will destroy them explicitly.
    this.dataServer?.unref();
    this.coordinatorServer?.unref();
    this.coordinatorSocket?.unref();
  }

  private startDataServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.dataServer = net.createServer((socket) => {
        this.handleDataConnection(socket);
      });
      this.dataServer.listen(0, COORDINATOR_HOST, () => {
        const addr = this.dataServer?.address();
        if (addr && typeof addr === "object") {
          this.dataPort = addr.port;
        }
        resolve();
      });
      this.dataServer.on("error", reject);
    });
  }

  private async tryJoinMesh(): Promise<void> {
    try {
      await this.connectToCoordinator();
    } catch {
      await this.becomeCoordinator();
    }
  }

  private connectToCoordinator(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(
        { port: this.coordinatorPort, host: COORDINATOR_HOST },
        () => {
          this.coordinatorSocket = socket;
          const intro: MeshMessage = {
            method: "introduce",
            peerId: this.peerId,
            dataPort: this.dataPort,
          };
          socket.write(encode(intro));

          // Read the peer_list response
          const buf = new MessageBuffer();
          socket.on("data", (data) => {
            const items = buf.append(data.toString());
            for (const item of items) {
              if (isMeshMessage(item)) {
                this.handleCoordinatorResponse(item);
              }
            }
          });
          socket.on("error", () => {
            /* ignore late errors */
          });
          clearTimeout(timer);
          resolve();
        },
      );

      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("Coordinator connection timeout"));
      }, 2000);

      socket.on("error", (err) => {
        clearTimeout(timer);
        socket.destroy();
        reject(err);
      });
    });
  }

  private handleCoordinatorResponse(msg: MeshMessage): void {
    if (msg.method === "peer_list") {
      for (const peer of msg.peers) {
        this.peerInfo.set(peer.id, peer);
        void this.connectToPeerData(peer);
      }
    } else if (msg.method === "peer_joined") {
      this.peerInfo.set(msg.peer.id, msg.peer);
      void this.connectToPeerData(msg.peer);
    }
  }

  private becomeCoordinator(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.coordinatorServer = net.createServer((socket) => {
        this.handleCoordinatorConnection(socket);
      });

      this.coordinatorServer.listen(
        this.coordinatorPort,
        COORDINATOR_HOST,
        () => {
          this.isCoordinator = true;
          this.startStaleCheck();
          this.peerInfo.set(this.peerId, {
            id: this.peerId,
            port: this.dataPort,
            startedAt: this.startedAt,
          });
          resolve();
        },
      );

      this.coordinatorServer.on("error", (err: unknown) => {
        const isAddrInUse =
          err instanceof Error && "code" in err && err.code === "EADDRINUSE";
        if (isAddrInUse) {
          this.coordinatorServer = undefined;
          void this.connectToCoordinator().then(resolve, reject);
        } else {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  // -----------------------------------------------------------------------
  // Coordinator protocol
  // -----------------------------------------------------------------------

  private handleCoordinatorConnection(socket: net.Socket): void {
    this.coordinatorServerSockets.add(socket);
    socket.on("close", () => this.coordinatorServerSockets.delete(socket));
    socket.on("error", () => {
      this.coordinatorServerSockets.delete(socket);
    });

    const buffer = new MessageBuffer();
    socket.on("data", (data) => {
      const items = buffer.append(data.toString());
      for (const item of items) {
        if (isMeshMessage(item) && item.method === "introduce") {
          void this.handleIntroduction(socket, item);
        }
      }
    });
  }

  private async handleIntroduction(
    socket: net.Socket,
    msg: { method: "introduce"; peerId: string; dataPort: number },
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
    await writeAsync(socket, encode(peerList));

    // Broadcast arrival to all existing data connections
    const joined: MeshMessage = { method: "peer_joined", peer: newPeer };
    await this.broadcastToDataConnections(joined);

    // Connect to the new peer's data server
    void this.connectToPeerData(newPeer);
  }

  // -----------------------------------------------------------------------
  // Data connections
  // -----------------------------------------------------------------------

  private handleDataConnection(socket: net.Socket): void {
    this.dataServerSockets.add(socket);
    socket.on("close", () => this.dataServerSockets.delete(socket));

    const buffer = new MessageBuffer();
    let remotePeerId: string | undefined;

    socket.on("data", (data) => {
      const items = buffer.append(data.toString());
      for (const item of items) {
        if (isMeshMessage(item)) {
          void this.handleDataMessage(item);
          if (item.method === "pong") {
            remotePeerId = item.peerId;
          }
        }
      }
      if (remotePeerId && !this.peerConnections.has(remotePeerId)) {
        this.peerConnections.set(remotePeerId, { socket, buffer });
      }
    });

    socket.on("close", () => {
      if (remotePeerId) this.peerConnections.delete(remotePeerId);
    });
    socket.on("error", () => {
      if (remotePeerId) this.peerConnections.delete(remotePeerId);
    });
  }

  private async handleDataMessage(msg: MeshMessage): Promise<void> {
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
          this.pendingMarkReadTimers.push(timer);
        }
        break;
      }
      case "message_read": {
        this.applyReadReceipt(patch.messageId, patch.readBy, patch.room);
        break;
      }
    }
  }

  private async connectToPeerData(peer: PeerInfo): Promise<void> {
    if (peer.id === this.peerId) return;
    if (this.peerConnections.has(peer.id)) return;

    return new Promise((resolve) => {
      const socket = net.createConnection(
        { port: peer.port, host: COORDINATOR_HOST },
        () => {
          const buf = new MessageBuffer();
          this.peerConnections.set(peer.id, { socket, buffer: buf });

          // Identify ourselves
          const pong: MeshMessage = { method: "pong", peerId: this.peerId };
          socket.write(encode(pong));

          // If we have state and peer doesn't, send state sync
          if (this.agents.size > 0) {
            const state: SerialisedState = {
              agents: Object.fromEntries(this.agents),
              rooms: Object.fromEntries(this.rooms),
              messages: Object.fromEntries(this.messages),
              dms: Object.fromEntries(this.dms),
            };
            socket.write(encode({ method: "state_sync", state }));
          }

          // Wire up ongoing message handling
          socket.on("data", (data) => {
            const items = buf.append(data.toString());
            for (const item of items) {
              if (isMeshMessage(item)) {
                void this.handleDataMessage(item);
              }
            }
          });

          resolve();
        },
      );

      socket.on("close", () => this.peerConnections.delete(peer.id));
      socket.on("error", () => {
        this.peerConnections.delete(peer.id);
        socket.destroy();
        resolve();
      });
    });
  }

  // -----------------------------------------------------------------------
  // Broadcast (async — writes to TCP sockets)
  // -----------------------------------------------------------------------

  private async broadcastToDataConnections(msg: MeshMessage): Promise<void> {
    const data = encode(msg);
    const writes: Promise<void>[] = [];
    for (const [, peer] of this.peerConnections) {
      writes.push(
        writeAsync(peer.socket, data).catch(() => {
          /* broken connection — cleanup handled by close/error listeners */
        }),
      );
    }
    await Promise.all(writes);
  }

  private async broadcastPatch(patch: MeshStatePatch): Promise<void> {
    await this.broadcastToDataConnections({ method: "state_update", patch });
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
      this.pendingMarkReadTimers.push(timer);
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
    }

    if (this.isCoordinator) {
      await this.handoverCoordinator();
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
      // Clean up stale peer from coordinator's registry
      this.peerInfo.delete(id);
      this.peerConnections.delete(id);
    }

    // Also purge long-offline agents to prevent indefinite accumulation
    const offlineThreshold = Date.now() - 30 * 60 * 1000; // 30 minutes
    const purgeIds: string[] = [];
    for (const [id, agent] of this.agents) {
      if (agent.status !== "offline") continue;
      const startedAt = new Date(agent.startedAt).getTime();
      // If the agent went offline long ago, purge it
      if (startedAt < offlineThreshold) {
        purgeIds.push(id);
      }
    }
    for (const id of purgeIds) {
      this.agents.delete(id);
      this.peerInfo.delete(id);
      this.peerConnections.delete(id);
      this.identityCache.delete(id);
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      // Sending signal 0 doesn't kill the process — it just checks existence
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Coordinator handover
  // -----------------------------------------------------------------------

  private async handoverCoordinator(): Promise<void> {
    if (!this.isCoordinator) return;

    let successor: PeerInfo | undefined;
    for (const [id, info] of this.peerInfo) {
      if (id === this.peerId) continue;
      if (!successor || info.startedAt < successor.startedAt) {
        successor = info;
      }
    }

    if (successor) {
      const peer = this.peerConnections.get(successor.id);
      if (peer) {
        const msg: MeshMessage = {
          method: "become_coordinator",
          peerList: [...this.peerInfo.values()].filter(
            (p) => p.id !== this.peerId,
          ),
        };
        await writeAsync(peer.socket, encode(msg)).catch(() => {
          /* successor socket already destroyed — nothing to hand over */
        });
      }
    }

    // Always clean up coordinator state, even with no successor
    this.stopStaleCheck();
    for (const socket of this.coordinatorServerSockets) {
      socket.unref();
      socket.destroy();
    }
    this.coordinatorServerSockets.clear();
    this.coordinatorServer?.unref();
    this.coordinatorServer?.close();
    this.coordinatorServer = undefined;
    this.isCoordinator = false;
  }

  // -----------------------------------------------------------------------
  // Shutdown
  // -----------------------------------------------------------------------

  async shutdown(): Promise<void> {
    this.isShutDown = true;
    // Clear any pending markRead timers so they don't fire after sockets
    // are destroyed (which would attempt writes on destroyed sockets) or
    // keep the event loop alive after process.exit().
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

    await this.handoverCoordinator();

    // Destroy the coordinator client socket (not tracked in peerConnections)
    this.coordinatorSocket?.unref();
    this.coordinatorSocket?.destroy();
    this.coordinatorSocket = undefined;

    // Destroy all identified peer connections
    for (const [, peer] of this.peerConnections) {
      peer.socket.unref();
      peer.socket.destroy();
    }
    this.peerConnections.clear();

    // Destroy all data server accepted sockets (including unidentified)
    for (const socket of this.dataServerSockets) {
      socket.unref();
      socket.destroy();
    }
    this.dataServerSockets.clear();

    // Destroy all coordinator server accepted sockets
    for (const socket of this.coordinatorServerSockets) {
      socket.unref();
      socket.destroy();
    }
    this.coordinatorServerSockets.clear();

    this.stopStaleCheck();

    // Close servers — stop accepting new connections
    this.dataServer?.unref();
    this.dataServer?.close();
    this.dataServer = undefined;
    this.coordinatorServer?.unref();
    this.coordinatorServer?.close();
    this.coordinatorServer = undefined;
  }
}

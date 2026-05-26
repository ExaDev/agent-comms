/**
 * FederationManager — manages TLS links between mesh coordinators.
 *
 * Federation links are persistent TLS connections between coordinators on
 * different machines. They forward agent presence, room memberships, and
 * messages for rooms marked as federated. Non-federated rooms never leave
 * the local mesh.
 *
 * Each link uses certificate pinning (the same trust model as TlsTransport).
 * The wire protocol runs over the same newline-delimited JSON framing as the
 * local mesh, but with `fed_*` method types.
 */

import * as tls from "node:tls";
import * as net from "node:net";
import { encode, isMeshMessage, MessageBuffer } from "./wire-protocol.js";
import type { MeshMessage } from "./wire-protocol.js";
import type { AgentIdentity, RoomMessage } from "./types.js";
import { nanoid } from "./nanoid.js";
import { generateIdentity } from "./identity.js";
import type { PeerIdentity } from "./identity.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Represents an active federation link (outbound or inbound). */
export interface FedLink {
  /** Unique ID for this link (assigned locally). */
  id: string;
  /** Remote mesh ID (received during handshake). */
  remoteMeshId: string;
  /** Human-readable name for the remote mesh. */
  remoteName: string;
  /** The TLS socket. */
  socket: tls.TLSSocket;
  /** Whether the handshake has completed successfully. */
  ready: boolean;
  /** Direction of the connection. */
  direction: "outbound" | "inbound";
}

/** Callbacks the FederationManager uses to interact with local mesh state. */
export interface FedCallbacks {
  /** Called when a remote agent becomes visible over a federation link. */
  onAgentVisible(agent: AgentIdentity): Promise<void>;
  /** Called when a remote agent goes offline/disappears. */
  onAgentGone(agentId: string): Promise<void>;
  /** Called when a message arrives for a federated room. */
  onRoomMessage(roomId: string, message: RoomMessage): Promise<void>;
  /** Called when a remote agent joins a federated room. */
  onRoomJoin(roomId: string, agentId: string, agentName: string): Promise<void>;
  /** Called when a remote agent leaves a federated room. */
  onRoomLeave(roomId: string, agentId: string): Promise<void>;
  /** Get all visible agents in the local mesh (for syncing to new links). */
  getVisibleAgents(): AgentIdentity[];
  /** Get all federated rooms and their member lists (for syncing to new links). */
  getFederatedRoomMemberships(): Map<string, string[]>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FED_PING_INTERVAL_MS = 30_000;
const FED_PING_TIMEOUT_MS = 10_000;
const FED_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// FederationManager
// ---------------------------------------------------------------------------

export class FederationManager {
  private links = new Map<string, FedLink>();
  private identity: PeerIdentity;
  private meshId: string;
  private meshName: string;
  private callbacks: FedCallbacks;
  private pingTimers = new Map<string, ReturnType<typeof setInterval>>();
  private shutDown = false;
  private pendingPongs = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(meshId: string, meshName: string, callbacks: FedCallbacks) {
    this.meshId = meshId;
    this.meshName = meshName;
    this.callbacks = callbacks;
    this.identity = generateIdentity();
  }

  /** The TLS identity used for federation connections. */
  get tlsIdentity(): PeerIdentity {
    return this.identity;
  }

  // -----------------------------------------------------------------------
  // Outbound links
  // -----------------------------------------------------------------------

  /**
   * Establish an outbound federation link to a remote coordinator.
   * Returns the local link ID once the handshake completes.
   */
  async connect(host: string, port: number, name?: string): Promise<string> {
    if (this.shutDown) throw new Error("FederationManager is shut down");

    const linkId = nanoid(8);

    const socket = await this.tlsConnect(host, port);
    const link: FedLink = {
      id: linkId,
      remoteMeshId: "",
      remoteName: name ?? `${host}:${String(port)}`,
      socket,
      ready: false,
      direction: "outbound",
    };
    this.links.set(linkId, link);

    // Send handshake
    const handshake: MeshMessage = {
      method: "fed_handshake",
      meshId: this.meshId,
      name: this.meshName,
      version: FED_VERSION,
    };
    await this.writeToSocket(socket, handshake);

    // Wire up incoming message handling
    this.wireSocket(linkId, socket);

    // Wait for fed_ack (with timeout)
    await this.waitForHandshake(linkId, 5000);

    return linkId;
  }

  // -----------------------------------------------------------------------
  // Inbound links (server)
  // -----------------------------------------------------------------------

  /**
   * Handle an incoming TLS connection that sent a fed_handshake.
   * Called by the transport layer when a federation connection arrives.
   */
  async handleInbound(socket: tls.TLSSocket): Promise<string> {
    if (this.shutDown) {
      socket.destroy();
      throw new Error("FederationManager is shut down");
    }

    const linkId = nanoid(8);
    const link: FedLink = {
      id: linkId,
      remoteMeshId: "",
      remoteName: "unknown",
      socket,
      ready: false,
      direction: "inbound",
    };
    this.links.set(linkId, link);

    this.wireSocket(linkId, socket);

    // Wait for the remote side's handshake
    await this.waitForHandshake(linkId, 5000);

    return linkId;
  }

  // -----------------------------------------------------------------------
  // Link management
  // -----------------------------------------------------------------------

  /** Disconnect a specific federation link. */
  async disconnect(linkId: string): Promise<void> {
    const link = this.links.get(linkId);
    if (!link) return;

    this.clearLinkTimers(linkId);
    link.ready = false;
    link.socket.unref();
    link.socket.destroy();
    this.links.delete(linkId);
  }

  /** List all active federation links. */
  listLinks(): FedLink[] {
    return [...this.links.values()].filter((l) => l.ready);
  }

  // -----------------------------------------------------------------------
  // Broadcasting to federated links
  // -----------------------------------------------------------------------

  /** Broadcast an agent visibility event to all ready links. */
  async broadcastAgentVisible(agent: AgentIdentity): Promise<void> {
    const msg: MeshMessage = { method: "fed_agent_visible", agent };
    await this.broadcastToReady(msg);
  }

  /** Broadcast an agent gone event to all ready links. */
  async broadcastAgentGone(agentId: string): Promise<void> {
    const msg: MeshMessage = { method: "fed_agent_gone", agentId };
    await this.broadcastToReady(msg);
  }

  /** Forward a room message to all ready links (federated rooms only). */
  async forwardRoomMessage(
    roomId: string,
    message: RoomMessage,
  ): Promise<void> {
    const msg: MeshMessage = { method: "fed_room_message", roomId, message };
    await this.broadcastToReady(msg);
  }

  /** Broadcast a room join to all ready links. */
  async broadcastRoomJoin(
    roomId: string,
    agentId: string,
    agentName: string,
  ): Promise<void> {
    const msg: MeshMessage = {
      method: "fed_room_join",
      roomId,
      agentId,
      agentName,
    };
    await this.broadcastToReady(msg);
  }

  /** Broadcast a room leave to all ready links. */
  async broadcastRoomLeave(roomId: string, agentId: string): Promise<void> {
    const msg: MeshMessage = { method: "fed_room_leave", roomId, agentId };
    await this.broadcastToReady(msg);
  }

  // -----------------------------------------------------------------------
  // Shutdown
  // -----------------------------------------------------------------------

  async shutdown(): Promise<void> {
    this.shutDown = true;
    for (const linkId of [...this.links.keys()]) {
      await this.disconnect(linkId);
    }
  }

  // -----------------------------------------------------------------------
  // Internal — TLS connection
  // -----------------------------------------------------------------------

  private tlsConnect(host: string, port: number): Promise<tls.TLSSocket> {
    return new Promise((resolve, reject) => {
      const socket = tls.connect(
        {
          key: this.identity.privateKey,
          cert: this.identity.certificate,
          host,
          port,
          rejectUnauthorized: false,
          requestCert: true,
        },
        () => {
          resolve(socket);
        },
      );

      const timer = setTimeout(() => {
        socket.destroy();
        reject(
          new Error(`Federation connection timeout to ${host}:${String(port)}`),
        );
      }, 5000);

      socket.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  // -----------------------------------------------------------------------
  // Internal — socket wiring
  // -----------------------------------------------------------------------

  private wireSocket(linkId: string, socket: tls.TLSSocket): void {
    const buffer = new MessageBuffer();

    socket.on("data", (data) => {
      const items = buffer.append(data.toString());
      for (const item of items) {
        if (isMeshMessage(item)) {
          void this.handleMessage(linkId, item);
        }
      }
    });

    socket.on("error", () => {
      void this.disconnect(linkId);
    });

    socket.on("close", () => {
      void this.disconnect(linkId);
    });
  }

  // -----------------------------------------------------------------------
  // Internal — message handling
  // -----------------------------------------------------------------------

  private async handleMessage(linkId: string, msg: MeshMessage): Promise<void> {
    const link = this.links.get(linkId);
    if (!link || this.shutDown) return;

    switch (msg.method) {
      case "fed_handshake": {
        // Inbound connection sending its handshake
        link.remoteMeshId = msg.meshId;
        link.remoteName = msg.name;
        link.ready = true;

        // Respond with ack
        const ack: MeshMessage = {
          method: "fed_ack",
          meshId: this.meshId,
          name: this.meshName,
          version: FED_VERSION,
        };
        await this.writeToSocket(link.socket, ack);

        // Sync local state to the new link
        await this.syncStateToLink(linkId);

        // Start ping for this link
        this.startPing(linkId);
        break;
      }
      case "fed_ack": {
        link.remoteMeshId = msg.meshId;
        link.remoteName = msg.name;
        link.ready = true;

        // Sync local state to the new link
        await this.syncStateToLink(linkId);

        // Start ping for this link
        this.startPing(linkId);
        break;
      }
      case "fed_agent_visible": {
        await this.callbacks.onAgentVisible(msg.agent);
        break;
      }
      case "fed_agent_gone": {
        await this.callbacks.onAgentGone(msg.agentId);
        break;
      }
      case "fed_room_message": {
        await this.callbacks.onRoomMessage(msg.roomId, msg.message);
        break;
      }
      case "fed_room_join": {
        await this.callbacks.onRoomJoin(msg.roomId, msg.agentId, msg.agentName);
        break;
      }
      case "fed_room_leave": {
        await this.callbacks.onRoomLeave(msg.roomId, msg.agentId);
        break;
      }
      case "fed_ping": {
        const pong: MeshMessage = { method: "fed_pong" };
        await this.writeToSocket(link.socket, pong);
        break;
      }
      case "fed_pong": {
        const pending = this.pendingPongs.get(linkId);
        if (pending) {
          clearTimeout(pending);
          this.pendingPongs.delete(linkId);
        }
        break;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Internal — state sync
  // -----------------------------------------------------------------------

  /**
   * After handshake, push our visible agents and federated room memberships
   * to the newly connected link.
   */
  private async syncStateToLink(linkId: string): Promise<void> {
    const link = this.links.get(linkId);
    if (!link?.ready) return;

    // Sync visible agents
    const agents = this.callbacks.getVisibleAgents();
    for (const agent of agents) {
      const msg: MeshMessage = { method: "fed_agent_visible", agent };
      await this.writeToSocket(link.socket, msg);
    }

    // Sync federated room memberships
    const rooms = this.callbacks.getFederatedRoomMemberships();
    for (const [roomId, memberIds] of rooms) {
      for (const memberId of memberIds) {
        const agent = this.callbacks
          .getVisibleAgents()
          .find((a) => a.id === memberId);
        const agentName = agent?.name ?? memberId;
        const msg: MeshMessage = {
          method: "fed_room_join",
          roomId,
          agentId: memberId,
          agentName,
        };
        await this.writeToSocket(link.socket, msg);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Internal — handshake waiting
  // -----------------------------------------------------------------------

  private waitForHandshake(linkId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();

      const check = (): void => {
        const link = this.links.get(linkId);
        if (link?.ready) {
          resolve();
          return;
        }
        if (Date.now() - startTime > timeoutMs) {
          void this.disconnect(linkId);
          reject(new Error(`Federation handshake timeout for link ${linkId}`));
          return;
        }
        setTimeout(check, 50);
      };

      check();
    });
  }

  // -----------------------------------------------------------------------
  // Internal — ping/pong health monitoring
  // -----------------------------------------------------------------------

  private startPing(linkId: string): void {
    if (this.pingTimers.has(linkId)) return;

    const timer = setInterval(() => {
      void this.sendPing(linkId);
    }, FED_PING_INTERVAL_MS);

    this.pingTimers.set(linkId, timer);
  }

  private async sendPing(linkId: string): Promise<void> {
    const link = this.links.get(linkId);
    if (!link?.ready) return;

    const msg: MeshMessage = { method: "fed_ping" };
    await this.writeToSocket(link.socket, msg);

    // Set pong timeout
    const timer = setTimeout(() => {
      // No pong received — disconnect the link
      void this.disconnect(linkId);
    }, FED_PING_TIMEOUT_MS);

    this.pendingPongs.set(linkId, timer);
  }

  // -----------------------------------------------------------------------
  // Internal — helpers
  // -----------------------------------------------------------------------

  private async writeToSocket(
    socket: tls.TLSSocket,
    msg: MeshMessage,
  ): Promise<void> {
    if (socket.destroyed) return;
    const data = encode(msg);
    await new Promise<void>((resolve, reject) => {
      socket.write(data, "utf-8", (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private async broadcastToReady(msg: MeshMessage): Promise<void> {
    const data = encode(msg);
    const writes: Promise<void>[] = [];
    for (const [, link] of this.links) {
      if (!link.ready || link.socket.destroyed) continue;
      writes.push(
        new Promise<void>((resolve) => {
          link.socket.write(data, "utf-8", (err) => {
            if (err) {
              void this.disconnect(link.id);
            }
            resolve();
          });
        }),
      );
    }
    await Promise.all(writes);
  }

  private clearLinkTimers(linkId: string): void {
    const pingTimer = this.pingTimers.get(linkId);
    if (pingTimer !== undefined) {
      clearInterval(pingTimer);
      this.pingTimers.delete(linkId);
    }
    const pongTimer = this.pendingPongs.get(linkId);
    if (pongTimer !== undefined) {
      clearTimeout(pongTimer);
      this.pendingPongs.delete(linkId);
    }
  }
}

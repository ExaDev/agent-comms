/**
 * TcpTransport — TCP localhost transport for the peer mesh.
 *
 * Owns all net.Server and net.Socket instances. Handles connection
 * establishment, framing, and message routing. Fires events via
 * TransportEvents for MeshStore to handle state management.
 *
 * Lifecycle mirrors the MeshTransport interface:
 *   1. startDataServer() — listen for incoming peer data connections
 *   2. connectToCoordinator() — join an existing mesh
 *      OR becomeCoordinator() — start a new mesh as coordinator
 *   3. connectToPeer() — establish data connection to a discovered peer
 *   4. send() / broadcast() — send wire messages
 *   5. shutdown() — close all connections and servers
 */

import * as net from "node:net";
import { encode, isMeshMessage, MessageBuffer } from "./wire-protocol.js";
import type { MeshMessage, PeerInfo } from "./wire-protocol.js";
import type {
  ConnectionHandle,
  ListenerInfo,
  ListenerPolicy,
  MeshTransport,
  TransportEvents,
} from "./transport.js";
import { nanoid } from "./nanoid.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Host all mesh servers bind to. */
const COORDINATOR_HOST = "127.0.0.1";

/** Timeout for connecting to the coordinator before giving up. */
const CONNECT_TIMEOUT_MS = 2000;

// ---------------------------------------------------------------------------
// Async socket write helper (not exported)
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
// TcpTransport
// ---------------------------------------------------------------------------

export class TcpTransport implements MeshTransport {
  // -- Data server (accepts incoming peer data connections) --
  private dataServer: net.Server | undefined;
  private _dataPort = 0;

  // -- Coordinator listeners (multiple adapters) --
  private coordinatorListeners = new Map<
    string,
    {
      server: net.Server;
      policy: ListenerPolicy;
      host: string;
      port: number;
      isDefault: boolean;
    }
  >();
  /** The default localhost listener ID (set once during becomeCoordinator). */
  private defaultListenerId: string | undefined;
  private _isCoordinator = false;

  // -- Coordinator client socket (connection to the coordinator) --
  private coordinatorSocket: net.Socket | undefined;

  // -- Peer data connections (peer ID → socket + buffer) --
  private peerConnections = new Map<
    string,
    { socket: net.Socket; buffer: MessageBuffer }
  >();

  // -- All sockets accepted by the data server (for shutdown cleanup) --
  private dataServerSockets = new Set<net.Socket>();

  // -- All sockets accepted by coordinator servers (for shutdown cleanup) --
  private coordinatorServerSockets = new Set<net.Socket>();

  // -- Coordinator introduction connections (handle ID → socket) --
  // Maps the introducing peer's ID to the coordinator server socket, so
  // MeshStore can send the peer_list response via transport.send().
  private introConnections = new Map<string, net.Socket>();

  // -- Pending connections awaiting approval (handle ID → socket + request info) --
  private pendingConnections = new Map<
    string,
    {
      socket: net.Socket;
      peerId: string;
      dataPort: number;
      name: string;
      fingerprint: string;
      policy: ListenerPolicy;
    }
  >();

  // -- Shutdown sentinel — prevents callbacks after shutdown() --
  private shutDown = false;

  // -- This peer's ID (set during connectToCoordinator or becomeCoordinator) --
  private _peerId = "";

  private readonly events: TransportEvents;

  constructor(events: TransportEvents) {
    this.events = events;
  }

  // -- Public getters for interface properties --

  get dataPort(): number {
    return this._dataPort;
  }

  get isCoordinator(): boolean {
    return this._isCoordinator;
  }

  // -----------------------------------------------------------------------
  // MeshTransport — Data server
  // -----------------------------------------------------------------------

  async startDataServer(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.dataServer = net.createServer((socket) => {
        this.handleIncomingDataConnection(socket);
      });
      this.dataServer.listen(0, COORDINATOR_HOST, () => {
        const addr = this.dataServer?.address();
        if (typeof addr === "object" && addr !== null) {
          this._dataPort = addr.port;
        }
        resolve();
      });
      this.dataServer.on("error", reject);
    });
  }

  // -----------------------------------------------------------------------
  // MeshTransport — Coordinator connection (client side)
  // -----------------------------------------------------------------------

  async connectToCoordinator(
    host: string,
    port: number,
    peerId: string,
    localDataPort: number,
  ): Promise<void> {
    this._peerId = peerId;
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ port, host }, () => {
        this.coordinatorSocket = socket;

        // Send introduction
        const intro: MeshMessage = {
          method: "introduce",
          peerId,
          dataPort: localDataPort,
        };
        socket.write(encode(intro));

        // Wire up coordinator message handling
        const buffer = new MessageBuffer();
        socket.on("data", (data) => {
          const items = buffer.append(data.toString());
          for (const item of items) {
            if (isMeshMessage(item)) {
              this.dispatchCoordinatorClientMessage(item);
            }
          }
        });
        socket.on("error", () => {
          /* ignore late errors on coordinator connection */
        });

        clearTimeout(timer);
        resolve();
      });

      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("Coordinator connection timeout"));
      }, CONNECT_TIMEOUT_MS);

      socket.on("error", (err) => {
        clearTimeout(timer);
        socket.destroy();
        reject(err);
      });
    });
  }

  // -----------------------------------------------------------------------
  // MeshTransport — Connect to remote coordinator with approval
  // -----------------------------------------------------------------------

  async connectToRemote(
    host: string,
    port: number,
    peerId: string,
    localDataPort: number,
    name: string,
    fingerprint: string,
  ): Promise<void> {
    this._peerId = peerId;
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ port, host }, () => {
        this.coordinatorSocket = socket;

        // Send connect_request instead of introduce
        const req: MeshMessage = {
          method: "connect_request",
          peerId,
          dataPort: localDataPort,
          name,
          fingerprint,
        };
        socket.write(encode(req));

        // Wire up coordinator message handling
        // Pending: wait for connect_accepted/rejected, then normal dispatch
        const buffer = new MessageBuffer();
        let approved = false;
        socket.on("data", (data) => {
          const items = buffer.append(data.toString());
          for (const item of items) {
            if (!isMeshMessage(item)) continue;

            if (!approved) {
              if (item.method === "connect_accepted") {
                approved = true;
                resolve();
              } else if (item.method === "connect_rejected") {
                socket.destroy();
                reject(new Error(`Connection rejected: ${item.reason}`));
                return;
              }
            } else {
              this.dispatchCoordinatorClientMessage(item);
            }
          }
        });
        socket.on("error", () => {
          /* ignore late errors on coordinator connection */
        });
      });

      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("Remote connection timeout"));
      }, CONNECT_TIMEOUT_MS);

      socket.on("error", (err) => {
        clearTimeout(timer);
        socket.destroy();
        reject(err);
      });
    });
  }

  // -----------------------------------------------------------------------
  // MeshTransport — Become coordinator (server side)
  // -----------------------------------------------------------------------

  async becomeCoordinator(host: string, port: number): Promise<void> {
    const id = nanoid(8);
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer((socket) => {
        this.handleCoordinatorServerConnection(socket, "full");
      });

      server.listen(port, host, () => {
        this._isCoordinator = true;
        this.coordinatorListeners.set(id, {
          server,
          policy: "full",
          host,
          port,
          isDefault: true,
        });
        this.defaultListenerId = id;
        resolve();
      });

      server.on("error", (err: unknown) => {
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  // -----------------------------------------------------------------------
  // MeshTransport — Multi-listener management
  // -----------------------------------------------------------------------

  async addListener(
    host: string,
    port: number,
    policy: ListenerPolicy,
  ): Promise<string> {
    if (!this._isCoordinator) {
      throw new Error("Only the coordinator can add listeners");
    }

    const id = nanoid(8);
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer((socket) => {
        this.handleCoordinatorServerConnection(socket, policy);
      });

      server.listen(port, host, () => {
        const addr = server.address();
        const actualPort =
          typeof addr === "object" && addr !== null ? addr.port : port;
        this.coordinatorListeners.set(id, {
          server,
          policy,
          host,
          port: actualPort,
          isDefault: false,
        });
        resolve();
      });

      server.on("error", (err: unknown) => {
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
    return id;
  }

  removeListener(id: string): Promise<void> {
    const listener = this.coordinatorListeners.get(id);
    if (!listener) {
      throw new Error(`Listener ${id} not found`);
    }
    if (listener.isDefault) {
      throw new Error("Cannot remove the default localhost listener");
    }

    listener.server.unref();
    listener.server.close();
    this.coordinatorListeners.delete(id);

    return Promise.resolve();
  }

  listListeners(): ListenerInfo[] {
    const result: ListenerInfo[] = [];
    for (const [id, listener] of this.coordinatorListeners) {
      result.push({
        id,
        host: listener.host,
        port: listener.port,
        policy: listener.policy,
        isDefault: listener.isDefault,
      });
    }
    return result;
  }

  // -----------------------------------------------------------------------
  // MeshTransport — Connect to a peer's data server
  // -----------------------------------------------------------------------

  async connectToPeer(peer: PeerInfo, ownPeerId: string): Promise<void> {
    if (this.peerConnections.has(peer.id)) return;

    await new Promise<void>((resolve) => {
      const socket = net.createConnection(
        { port: peer.port, host: COORDINATOR_HOST },
        () => {
          const buffer = new MessageBuffer();
          this.peerConnections.set(peer.id, { socket, buffer });

          // Identify ourselves
          const pong: MeshMessage = { method: "pong", peerId: ownPeerId };
          socket.write(encode(pong));

          // Wire up ongoing message handling
          socket.on("data", (data) => {
            const items = buffer.append(data.toString());
            for (const item of items) {
              if (isMeshMessage(item)) {
                const handle: ConnectionHandle = { id: peer.id };
                this.dispatchDataMessage(handle, item);
              }
            }
          });

          resolve();
        },
      );

      const handle: ConnectionHandle = { id: peer.id };
      let disconnected = false;

      const onDisconnect = (): void => {
        if (disconnected) return;
        disconnected = true;
        const wasConnected = this.peerConnections.has(peer.id);
        this.peerConnections.delete(peer.id);
        if (wasConnected && !this.shutDown) {
          this.events.onPeerDisconnected(handle);
        }
      };

      socket.on("close", onDisconnect);
      socket.on("error", () => {
        onDisconnect();
        socket.destroy();
        resolve();
      });
    });
  }

  // -----------------------------------------------------------------------
  // MeshTransport — Send / broadcast
  // -----------------------------------------------------------------------

  async send(handle: ConnectionHandle, message: MeshMessage): Promise<void> {
    // Check data connections first
    const peerConn = this.peerConnections.get(handle.id);
    if (peerConn) {
      await writeAsync(peerConn.socket, encode(message));
      return;
    }

    // Check coordinator introduction connections
    const introSocket = this.introConnections.get(handle.id);
    if (introSocket) {
      await writeAsync(introSocket, encode(message));
      return;
    }

    throw new Error(`No connection for handle ${handle.id}`);
  }

  async acceptConnection(handle: ConnectionHandle): Promise<void> {
    const pending = this.pendingConnections.get(handle.id);
    if (!pending) {
      throw new Error(`No pending connection for handle ${handle.id}`);
    }
    this.pendingConnections.delete(handle.id);

    const { socket, peerId, dataPort, name, fingerprint, policy } = pending;

    // Move to introConnections so send() can reach this peer
    this.introConnections.set(peerId, socket);

    // Send acceptance to the connecting peer
    const accepted: MeshMessage = {
      method: "connect_accepted",
      peerId: this._peerId,
      dataPort: this._dataPort,
    };
    await writeAsync(socket, encode(accepted));

    // Fire onIntroduction so MeshStore processes the new peer normally
    const connHandle: ConnectionHandle = { id: peerId, policy };
    this.events.onIntroduction(connHandle, { peerId, dataPort });

    // Suppress unused-var warnings
    void name;
    void fingerprint;
  }

  async rejectConnection(
    handle: ConnectionHandle,
    reason: string,
  ): Promise<void> {
    const pending = this.pendingConnections.get(handle.id);
    if (!pending) {
      throw new Error(`No pending connection for handle ${handle.id}`);
    }
    this.pendingConnections.delete(handle.id);

    const { socket } = pending;

    const rejected: MeshMessage = {
      method: "connect_rejected",
      peerId: handle.id,
      reason,
    };
    await writeAsync(socket, encode(rejected));
    socket.destroy();
  }

  async broadcast(message: MeshMessage): Promise<void> {
    const data = encode(message);
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

  // -----------------------------------------------------------------------
  // MeshTransport — Shutdown / unref
  // -----------------------------------------------------------------------

  shutdown(): Promise<void> {
    this.shutDown = true;

    // Destroy the coordinator client socket
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

    // Clear introduction connection tracking
    this.introConnections.clear();

    // Clear pending connections
    for (const [, pending] of this.pendingConnections) {
      pending.socket.unref();
      pending.socket.destroy();
    }
    this.pendingConnections.clear();

    // Close data server
    this.dataServer?.unref();
    this.dataServer?.close();
    this.dataServer = undefined;

    // Close coordinator listener servers — stop accepting new connections
    for (const [, listener] of this.coordinatorListeners) {
      listener.server.unref();
      listener.server.close();
    }
    this.coordinatorListeners.clear();
    this.defaultListenerId = undefined;

    this._isCoordinator = false;

    return Promise.resolve();
  }

  unref(): void {
    this.dataServer?.unref();
    for (const [, listener] of this.coordinatorListeners) {
      listener.server.unref();
    }
    this.coordinatorSocket?.unref();
  }

  // -----------------------------------------------------------------------
  // Internal — Coordinator client message dispatch
  // -----------------------------------------------------------------------

  /**
   * Handles messages received on the coordinator client socket (the
   * connection from this peer TO the coordinator). Fires the appropriate
   * TransportEvents for peer_list, peer_joined, and become_coordinator.
   */
  private dispatchCoordinatorClientMessage(msg: MeshMessage): void {
    if (this.shutDown) return;

    if (msg.method === "peer_list") {
      this.events.onPeerList(msg.peers);
    } else if (msg.method === "peer_joined") {
      this.events.onPeerJoined(msg.peer);
    } else if (msg.method === "become_coordinator") {
      this.events.onBecomeCoordinator(msg.peerList);
    }
  }

  // -----------------------------------------------------------------------
  // Internal — Data message dispatch
  // -----------------------------------------------------------------------

  /**
   * Routes a message received on a peer data connection to the
   * appropriate event. become_coordinator has its own event; all
   * other messages fire onMessage for MeshStore to handle.
   */
  private dispatchDataMessage(
    handle: ConnectionHandle,
    msg: MeshMessage,
  ): void {
    if (this.shutDown) return;

    if (msg.method === "become_coordinator") {
      this.events.onBecomeCoordinator(msg.peerList);
    } else {
      this.events.onMessage(handle, msg);
    }
  }

  // -----------------------------------------------------------------------
  // Internal — Coordinator server connection handling
  // -----------------------------------------------------------------------

  /**
   * Accepts a new connection on a coordinator server. Reads
   * introduce messages and fires onIntroduction so MeshStore can
   * respond with the peer list and broadcast the arrival.
   * The connection is tagged with the listener's policy.
   */
  private handleCoordinatorServerConnection(
    socket: net.Socket,
    policy: ListenerPolicy,
  ): void {
    if (this.shutDown) {
      socket.destroy();
      return;
    }

    this.coordinatorServerSockets.add(socket);
    socket.on("close", () => this.coordinatorServerSockets.delete(socket));
    socket.on("error", () => this.coordinatorServerSockets.delete(socket));

    const buffer = new MessageBuffer();
    socket.on("data", (data) => {
      const items = buffer.append(data.toString());
      for (const item of items) {
        if (!isMeshMessage(item)) continue;

        if (item.method === "introduce") {
          const handle: ConnectionHandle = { id: item.peerId, policy };
          this.introConnections.set(handle.id, socket);
          this.events.onIntroduction(handle, {
            peerId: item.peerId,
            dataPort: item.dataPort,
          });
        } else if (item.method === "connect_request") {
          const handle: ConnectionHandle = { id: item.peerId, policy };
          this.pendingConnections.set(handle.id, {
            socket,
            peerId: item.peerId,
            dataPort: item.dataPort,
            name: item.name,
            fingerprint: item.fingerprint,
            policy,
          });
          this.events.onConnectionRequest(handle, {
            peerId: item.peerId,
            dataPort: item.dataPort,
            name: item.name,
            fingerprint: item.fingerprint,
          });
        }
      }
    });
  }

  // -----------------------------------------------------------------------
  // Internal — Incoming data connection handling
  // -----------------------------------------------------------------------

  /**
   * Accepts a new connection on the data server. Reads the initial
   * pong to identify the peer, then fires onMessage for subsequent
   * messages. Tracks the connection for cleanup on close/error.
   */
  private handleIncomingDataConnection(socket: net.Socket): void {
    if (this.shutDown) {
      socket.destroy();
      return;
    }

    this.dataServerSockets.add(socket);
    socket.on("close", () => this.dataServerSockets.delete(socket));

    const buffer = new MessageBuffer();
    let remotePeerId: string | undefined;
    let disconnected = false;

    socket.on("data", (data) => {
      const items = buffer.append(data.toString());
      for (const item of items) {
        if (isMeshMessage(item)) {
          if (item.method === "pong") {
            const peerId = item.peerId;
            remotePeerId = peerId;
            if (!this.peerConnections.has(peerId)) {
              this.peerConnections.set(peerId, { socket, buffer });
            }
            const handle: ConnectionHandle = { id: peerId };
            const info: PeerInfo = {
              id: peerId,
              port: 0,
              startedAt: new Date().toISOString(),
            };
            this.events.onPeerConnected(handle, info);
          } else if (remotePeerId !== undefined) {
            const handle: ConnectionHandle = { id: remotePeerId };
            this.dispatchDataMessage(handle, item);
          }
        }
      }
    });

    const onDisconnect = (): void => {
      if (disconnected) return;
      disconnected = true;
      if (remotePeerId !== undefined) {
        this.peerConnections.delete(remotePeerId);
        if (!this.shutDown) {
          this.events.onPeerDisconnected({ id: remotePeerId });
        }
      }
    };

    socket.on("close", onDisconnect);
    socket.on("error", onDisconnect);
  }
}

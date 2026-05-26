/**
 * WebSocketTransport — WebSocket transport for the peer mesh.
 *
 * Carries the same wire protocol as TcpTransport but over WebSocket frames.
 * Each WS frame is a complete JSON message — no newline delimiter or
 * MessageBuffer needed. This enables browser-based peers (PWAs) to
 * participate in the mesh.
 *
 * The transport is a drop-in replacement for TcpTransport. Same interface,
 * same wire protocol, same event callbacks. MeshStore cannot tell the
 * difference.
 */

import { WebSocket, WebSocketServer } from "ws";
import { isMeshMessage } from "./wire-protocol.js";
import type { MeshMessage, PeerInfo } from "./wire-protocol.js";
import type {
  ConnectionHandle,
  MeshTransport,
  TransportEvents,
} from "./transport.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Timeout for connecting to the coordinator before giving up. */
const CONNECT_TIMEOUT_MS = 2000;

// ---------------------------------------------------------------------------
// Async WS send helper (not exported)
// ---------------------------------------------------------------------------

function sendAsync(ws: WebSocket, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState !== WebSocket.OPEN) {
      resolve();
      return;
    }
    ws.send(data, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// WebSocketTransport
// ---------------------------------------------------------------------------

export class WebSocketTransport implements MeshTransport {
  // -- Data server (accepts incoming peer data connections) --
  private dataServer: WebSocketServer | undefined;
  private _dataPort = 0;

  // -- Coordinator server (accepts introductions from new peers) --
  private coordinatorServer: WebSocketServer | undefined;
  private _isCoordinator = false;

  // -- Coordinator client socket (connection to the coordinator) --
  private coordinatorWs: WebSocket | undefined;

  // -- Peer data connections (peer ID → WebSocket) --
  private peerConnections = new Map<string, WebSocket>();

  // -- All WS connections accepted by the data server (for shutdown cleanup) --
  private dataServerSockets = new Set<WebSocket>();

  // -- All WS connections accepted by the coordinator server (for shutdown cleanup) --
  private coordinatorServerSockets = new Set<WebSocket>();

  // -- Coordinator introduction connections (handle ID → WebSocket) --
  // Maps the introducing peer's ID to the coordinator server WS, so
  // MeshStore can send the peer_list response via transport.send().
  private introConnections = new Map<string, WebSocket>();

  // -- Pending connections awaiting approval (handle ID → WS + request info) --
  private pendingConnections = new Map<
    string,
    {
      ws: WebSocket;
      peerId: string;
      dataPort: number;
      name: string;
      fingerprint: string;
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
      // WebSocketServer needs an underlying HTTP server to get an
      // OS-assigned port via port 0.
      this.dataServer = new WebSocketServer({ port: 0, host: "0.0.0.0" });

      this.dataServer.on("error", reject);

      this.dataServer.on("listening", () => {
        const addr = this.dataServer?.address();
        if (typeof addr === "object" && addr !== null) {
          this._dataPort = addr.port;
        }
        resolve();
      });

      this.dataServer.on("connection", (ws) => {
        this.handleIncomingDataConnection(ws);
      });
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
      const url = `ws://${host}:${port}`;
      const ws = new WebSocket(url);

      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error("Coordinator connection timeout"));
      }, CONNECT_TIMEOUT_MS);

      ws.on("unexpected-response", () => {
        clearTimeout(timer);
        ws.terminate();
        reject(new Error("Coordinator connection rejected"));
      });

      ws.on("open", () => {
        this.coordinatorWs = ws;

        // Send introduction
        const intro: MeshMessage = {
          method: "introduce",
          peerId,
          dataPort: localDataPort,
        };
        ws.send(JSON.stringify(intro));

        // Wire up coordinator message handling
        ws.on("message", (raw) => {
          const msg = parseMessage(raw);
          if (msg !== undefined) {
            this.dispatchCoordinatorClientMessage(msg);
          }
        });
        ws.on("error", () => {
          /* ignore late errors on coordinator connection */
        });

        clearTimeout(timer);
        resolve();
      });

      ws.on("error", (err) => {
        clearTimeout(timer);
        ws.terminate();
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
    _localDataPort: number,
    name: string,
    fingerprint: string,
  ): Promise<void> {
    this._peerId = peerId;
    await new Promise<void>((resolve, reject) => {
      const url = `ws://${host}:${port}`;
      const ws = new WebSocket(url);

      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error("Remote connection timeout"));
      }, CONNECT_TIMEOUT_MS);

      ws.on("unexpected-response", () => {
        clearTimeout(timer);
        ws.terminate();
        reject(new Error("Remote connection rejected"));
      });

      ws.on("open", () => {
        this.coordinatorWs = ws;

        // Send connect_request instead of introduce
        const req: MeshMessage = {
          method: "connect_request",
          peerId,
          dataPort: _localDataPort,
          name,
          fingerprint,
        };
        ws.send(JSON.stringify(req));

        // Wait for connect_accepted or connect_rejected
        let approved = false;
        ws.on("message", (raw) => {
          const msg = parseMessage(raw);
          if (msg === undefined) return;

          if (!approved) {
            if (msg.method === "connect_accepted") {
              approved = true;
              clearTimeout(timer);
              resolve();
            } else if (msg.method === "connect_rejected") {
              clearTimeout(timer);
              ws.terminate();
              reject(new Error(`Connection rejected: ${msg.reason}`));
              return;
            }
          } else {
            this.dispatchCoordinatorClientMessage(msg);
          }
        });
        ws.on("error", () => {
          /* ignore late errors on coordinator connection */
        });
      });

      ws.on("error", (err) => {
        clearTimeout(timer);
        ws.terminate();
        reject(err);
      });
    });
  }

  // -----------------------------------------------------------------------
  // MeshTransport — Become coordinator (server side)
  // -----------------------------------------------------------------------

  async becomeCoordinator(host: string, port: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.coordinatorServer = new WebSocketServer({ host, port });

      this.coordinatorServer.on("error", (err: unknown) => {
        reject(err instanceof Error ? err : new Error(String(err)));
      });

      this.coordinatorServer.on("listening", () => {
        this._isCoordinator = true;
        resolve();
      });

      this.coordinatorServer.on("connection", (ws) => {
        this.handleCoordinatorServerConnection(ws);
      });
    });
  }

  // -----------------------------------------------------------------------
  // MeshTransport — Connect to a peer's data server
  // -----------------------------------------------------------------------

  async connectToPeer(peer: PeerInfo, ownPeerId: string): Promise<void> {
    if (this.peerConnections.has(peer.id)) return;

    await new Promise<void>((resolve) => {
      const url = `ws://127.0.0.1:${peer.port}`;
      const ws = new WebSocket(url);

      ws.on("open", () => {
        this.peerConnections.set(peer.id, ws);

        // Identify ourselves
        const pong: MeshMessage = { method: "pong", peerId: ownPeerId };
        ws.send(JSON.stringify(pong));

        // Wire up ongoing message handling
        ws.on("message", (raw) => {
          const msg = parseMessage(raw);
          if (msg !== undefined) {
            const handle: ConnectionHandle = { id: peer.id };
            this.dispatchDataMessage(handle, msg);
          }
        });

        resolve();
      });

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

      ws.on("close", onDisconnect);
      ws.on("error", () => {
        onDisconnect();
        ws.terminate();
        resolve();
      });
    });
  }

  // -----------------------------------------------------------------------
  // MeshTransport — Send / broadcast
  // -----------------------------------------------------------------------

  async send(handle: ConnectionHandle, message: MeshMessage): Promise<void> {
    const data = JSON.stringify(message);

    // Check data connections first
    const peerWs = this.peerConnections.get(handle.id);
    if (peerWs) {
      await sendAsync(peerWs, data);
      return;
    }

    // Check coordinator introduction connections
    const introWs = this.introConnections.get(handle.id);
    if (introWs) {
      await sendAsync(introWs, data);
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

    const { ws, peerId, dataPort, name, fingerprint } = pending;

    // Move to introConnections so send() can reach this peer
    this.introConnections.set(peerId, ws);

    // Send acceptance to the connecting peer
    const accepted: MeshMessage = {
      method: "connect_accepted",
      peerId: this._peerId,
      dataPort: this._dataPort,
    };
    await sendAsync(ws, JSON.stringify(accepted));

    // Fire onIntroduction so MeshStore processes the new peer normally
    const connHandle: ConnectionHandle = { id: peerId };
    this.events.onIntroduction(connHandle, { peerId, dataPort });

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

    const { ws } = pending;

    const rejected: MeshMessage = {
      method: "connect_rejected",
      peerId: handle.id,
      reason,
    };
    await sendAsync(ws, JSON.stringify(rejected));
    ws.terminate();
  }

  async broadcast(message: MeshMessage): Promise<void> {
    const data = JSON.stringify(message);
    const writes: Promise<void>[] = [];
    for (const [, ws] of this.peerConnections) {
      writes.push(
        sendAsync(ws, data).catch(() => {
          /* broken connection — cleanup handled by close/error listeners */
        }),
      );
    }
    await Promise.all(writes);
  }

  // -----------------------------------------------------------------------
  // MeshTransport — Listener management (not supported over WebSocket)
  // -----------------------------------------------------------------------

  async addListener(): Promise<string> {
    throw new Error("WebSocketTransport does not support listener management");
  }

  async removeListener(): Promise<void> {
    throw new Error("WebSocketTransport does not support listener management");
  }

  listListeners(): import("./transport.js").ListenerInfo[] {
    return [];
  }

  // -----------------------------------------------------------------------
  // MeshTransport — Shutdown / unref
  // -----------------------------------------------------------------------

  async shutdown(): Promise<void> {
    this.shutDown = true;

    // Destroy the coordinator client socket
    this.coordinatorWs?.terminate();
    this.coordinatorWs = undefined;

    // Destroy all identified peer connections
    for (const [, ws] of this.peerConnections) {
      ws.terminate();
    }
    this.peerConnections.clear();

    // Destroy all data server accepted sockets (including unidentified)
    for (const ws of this.dataServerSockets) {
      ws.terminate();
    }
    this.dataServerSockets.clear();

    // Destroy all coordinator server accepted sockets
    for (const ws of this.coordinatorServerSockets) {
      ws.terminate();
    }
    this.coordinatorServerSockets.clear();

    // Clear introduction connection tracking
    this.introConnections.clear();

    // Clear pending connections
    for (const [, pending] of this.pendingConnections) {
      pending.ws.terminate();
    }
    this.pendingConnections.clear();

    // Close servers — stop accepting new connections
    this.dataServer?.close();
    this.dataServer = undefined;
    this.coordinatorServer?.close();
    this.coordinatorServer = undefined;

    this._isCoordinator = false;
  }

  unref(): void {
    // WebSocketServer doesn't have an unref() method the way net.Server
    // does. The servers will be closed on shutdown(). Peer WS connections
    // are cleaned up on shutdown() as well.
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
   * Accepts a new connection on the coordinator server. Reads
   * introduce messages and fires onIntroduction so MeshStore can
   * respond with the peer list and broadcast the arrival.
   */
  private handleCoordinatorServerConnection(ws: WebSocket): void {
    if (this.shutDown) {
      ws.terminate();
      return;
    }

    this.coordinatorServerSockets.add(ws);
    ws.on("close", () => this.coordinatorServerSockets.delete(ws));
    ws.on("error", () => this.coordinatorServerSockets.delete(ws));

    ws.on("message", (raw) => {
      const msg = parseMessage(raw);
      if (msg === undefined) return;

      if (msg.method === "introduce") {
        const handle: ConnectionHandle = { id: msg.peerId };
        this.introConnections.set(handle.id, ws);
        this.events.onIntroduction(handle, {
          peerId: msg.peerId,
          dataPort: msg.dataPort,
        });
      } else if (msg.method === "connect_request") {
        const handle: ConnectionHandle = { id: msg.peerId };
        this.pendingConnections.set(handle.id, {
          ws,
          peerId: msg.peerId,
          dataPort: msg.dataPort,
          name: msg.name,
          fingerprint: msg.fingerprint,
        });
        this.events.onConnectionRequest(handle, {
          peerId: msg.peerId,
          dataPort: msg.dataPort,
          name: msg.name,
          fingerprint: msg.fingerprint,
        });
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
  private handleIncomingDataConnection(ws: WebSocket): void {
    if (this.shutDown) {
      ws.terminate();
      return;
    }

    this.dataServerSockets.add(ws);
    ws.on("close", () => this.dataServerSockets.delete(ws));

    let remotePeerId: string | undefined;
    let disconnected = false;

    ws.on("message", (raw) => {
      const msg = parseMessage(raw);
      if (msg === undefined) return;

      if (msg.method === "pong") {
        const peerId = msg.peerId;
        remotePeerId = peerId;
        if (!this.peerConnections.has(peerId)) {
          this.peerConnections.set(peerId, ws);
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
        this.dispatchDataMessage(handle, msg);
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

    ws.on("close", onDisconnect);
    ws.on("error", onDisconnect);
  }
}

// ---------------------------------------------------------------------------
// Message parsing (not exported)
// ---------------------------------------------------------------------------

/**
 * Parse a raw WS message into a MeshMessage, returning undefined for
 * malformed data. Unlike TCP, each WS frame is a complete message —
 * no newline delimiter or buffer splitting required.
 */
function parseMessage(raw: unknown): MeshMessage | undefined {
  if (raw === undefined) return undefined;

  // WS data arrives as Buffer in Node, string in browsers
  let text: string;
  if (typeof raw === "string") {
    text = raw;
  } else if (raw instanceof Buffer || ArrayBuffer.isView(raw)) {
    text = new TextDecoder().decode(
      raw instanceof Buffer ? raw : new Uint8Array(raw.buffer),
    );
  } else if (raw instanceof ArrayBuffer) {
    text = new TextDecoder().decode(raw);
  } else {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(text);
    return isMeshMessage(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

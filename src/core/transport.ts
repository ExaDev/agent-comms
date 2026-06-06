/**
 * MeshTransport — abstract transport layer for the peer mesh.
 *
 * The transport owns connections (TCP sockets, TLS sockets, WebSockets)
 * and provides send/receive primitives. MeshStore handles state management
 * and delegates all I/O to the transport.
 *
 * Lifecycle:
 *   1. startDataServer() — listen for incoming peer data connections
 *   2. connectToCoordinator() — join an existing mesh
 *      OR becomeCoordinator() — start a new mesh as coordinator
 *   3. connectToPeer() — establish data connection to a discovered peer
 *   4. send() / broadcast() — send wire messages
 *   5. shutdown() — close all connections and servers
 *
 * The transport emits received messages via the onMessage callback.
 * It does not interpret messages — that's MeshStore's job.
 */

import type { MeshMessage, PeerInfo } from "./wire-protocol.js";

// ---------------------------------------------------------------------------
// Connection handle — opaque reference to a specific peer connection
// ---------------------------------------------------------------------------

/**
 * A handle identifying a specific peer connection. The transport creates
 * these and passes them to MeshStore via callbacks. MeshStore uses them
 * as keys for send() and to identify message sources.
 */
export type ListenerPolicy = "full" | "observe" | "rooms-only" | "gateway";

export interface ListenerInfo {
  id: string;
  host: string;
  port: number;
  policy: ListenerPolicy;
  /** Whether this is the default localhost listener (cannot be removed). */
  isDefault: boolean;
}

export interface ConnectionHandle {
  /** Stable identifier for this connection (used as peer ID once identified). */
  id: string;
  /** Policy inherited from the listener that accepted this connection. */
  policy?: ListenerPolicy;
}

// ---------------------------------------------------------------------------
// Transport events
// ---------------------------------------------------------------------------

export interface TransportEvents {
  /**
   * A wire message was received from a peer.
   * Called for every complete message after framing.
   */
  onMessage(handle: ConnectionHandle, message: MeshMessage): void;

  /**
   * A new data connection was established and the peer identified itself
   * via a pong message. MeshStore should wire up state handling for this peer.
   */
  onPeerConnected(handle: ConnectionHandle, info: PeerInfo): void;

  /**
   * A peer connection was lost (close, error, or timeout).
   */
  onPeerDisconnected(handle: ConnectionHandle): void;

  /**
   * A non-fatal error occurred that consumers should know about.
   */
  onError?(error: Error): void;

  /**
   * A peer introduced itself to the coordinator.
   * Only fires on the coordinator instance.
   * MeshStore should send the peer list and broadcast the arrival.
   */
  onIntroduction(
    handle: ConnectionHandle,
    msg: { peerId: string; dataPort: number },
  ): void;

  /**
   * A new peer introduced itself and is awaiting approval.
   * Replaces onIntroduction when connection approval is active.
   * Only fires on the coordinator instance.
   * MeshStore should queue the request and deliver a connection_request
   * event to the owning agent.
   */
  onConnectionRequest(
    handle: ConnectionHandle,
    info: {
      peerId: string;
      dataPort: number;
      name: string;
      fingerprint: string;
    },
  ): void;

  /**
   * The coordinator sent us a peer list (received during initial connection).
   * MeshStore should connect to each peer's data server.
   */
  onPeerList(peers: PeerInfo[]): void;

  /**
   * The coordinator told us a new peer joined.
   */
  onPeerJoined(peer: PeerInfo): void;

  /**
   * We received a become_coordinator message — take over as coordinator.
   */
  onBecomeCoordinator(peerList: PeerInfo[]): void;
}

// ---------------------------------------------------------------------------
// MeshTransport interface
// ---------------------------------------------------------------------------

export interface MeshTransport {
  /** The port this instance's data server is listening on (0 before startDataServer). */
  readonly dataPort: number;

  /** Whether this instance is the mesh coordinator. */
  readonly isCoordinator: boolean;

  /** Whether this instance has a live connection to a coordinator. */
  readonly hasCoordinatorConnection: boolean;

  /**
   * Start the data server on an OS-assigned port.
   * Resolves when the server is listening.
   */
  startDataServer(): Promise<void>;

  /**
   * Connect to the coordinator at the given host:port and send an
   * introduction message. Resolves when the connection is established
   * and the introduction has been sent.
   * Rejects if no coordinator is reachable (caller should becomeCoordinator).
   */
  connectToCoordinator(
    host: string,
    port: number,
    peerId: string,
    dataPort: number,
  ): Promise<void>;

  /**
   * Start listening as the coordinator on the given host:port.
   * Resolves when the coordinator server is listening.
   */
  becomeCoordinator(host: string, port: number): Promise<void>;

  /**
   * Connect to a peer's data server and send a pong identification.
   * Resolves when the connection is established and pong sent.
   * No-op if already connected to this peer.
   */
  connectToPeer(peer: PeerInfo, ownPeerId: string): Promise<void>;

  /**
   * Send a wire message to a specific peer connection.
   */
  send(handle: ConnectionHandle, message: MeshMessage): Promise<void>;

  /**
   * Accept a pending connection. Sends connect_accepted and processes
   * the introduction as normal (peer_list, peer_joined broadcast).
   */
  acceptConnection(handle: ConnectionHandle): Promise<void>;

  /**
   * Reject a pending connection. Sends connect_rejected and closes the socket.
   */
  rejectConnection(handle: ConnectionHandle, reason: string): Promise<void>;

  /**
   * Initiate an outbound connection that requires approval.
   * Sends connect_request instead of introduce and waits for
   * connect_accepted or connect_rejected from the remote coordinator.
   */
  connectToRemote(
    host: string,
    port: number,
    peerId: string,
    dataPort: number,
    name: string,
    fingerprint: string,
  ): Promise<void>;

  /**
   * Broadcast a wire message to all connected peer data connections.
   */
  broadcast(message: MeshMessage): Promise<void>;

  /**
   * Add a coordinator listener on a specific adapter.
   * Only valid when this instance is the coordinator.
   * Returns listener ID.
   */
  addListener(
    host: string,
    port: number,
    policy: ListenerPolicy,
  ): Promise<string>;

  /**
   * Remove a listener by ID. Cannot remove the default localhost listener.
   */
  removeListener(id: string): Promise<void>;

  /** List all active listeners. */
  listListeners(): ListenerInfo[];

  /**
   * Gracefully shut down all servers and connections.
   * After shutdown, no further callbacks will fire.
   */
  shutdown(): Promise<void>;

  /**
   * Unref all root handles so the event loop can exit when the
   * agent process shuts down. Sockets still function for I/O but
   * don't keep the process alive.
   */
  unref(): void;
}

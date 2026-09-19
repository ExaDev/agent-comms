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
import type {
  CapabilityScope,
  CapabilityToken,
  ManageCommand,
  RevocationEntry,
} from "wire-mesh-core/generated/protocol";
import type { ManageOutcome } from "wire-mesh-core/domain/mesh-session";
import type { AgentStatus } from "./types.js";
import type { ConnectToRemoteOptions } from "./wire-mesh-transport-options.js";

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
   * A wire message was received from a peer. Called for every complete message after framing.
   */
  onMessage: (handle: Readonly<ConnectionHandle>, message: MeshMessage) => void;

  /**
   * A new data connection was established and the peer identified itself via a pong message. MeshStore should wire up state handling for this peer.
   */
  onPeerConnected: (
    handle: Readonly<ConnectionHandle>,
    info: Readonly<PeerInfo>,
  ) => void;

  /**
   * A peer connection was lost (close, error, or timeout).
   */
  onPeerDisconnected: (handle: Readonly<ConnectionHandle>) => void;

  /**
   * A non-fatal error occurred that consumers should know about.
   */
  onError?: (error: Error) => void;

  /**
   * A peer introduced itself to the coordinator. Only fires on the coordinator instance. MeshStore should send the peer list and broadcast the arrival.
   */
  onIntroduction: (
    handle: Readonly<ConnectionHandle>,
    msg: Readonly<{ peerId: string; dataPort: number }>,
  ) => void;

  /**
   * A new peer introduced itself and is awaiting approval. Replaces onIntroduction when connection approval is active. Only fires on the coordinator instance. MeshStore should queue the request and deliver a connection_request event to the owning agent.
   */
  onConnectionRequest: (
    handle: Readonly<ConnectionHandle>,
    info: Readonly<{
      peerId: string;
      dataPort: number;
      name: string;
      fingerprint: string;
    }>,
  ) => void;

  /**
   * The coordinator sent us a peer list (received during initial connection). MeshStore should connect to each peer's data server.
   */
  onPeerList: (peers: readonly PeerInfo[]) => void;

  /**
   * The coordinator told us a new peer joined.
   */
  onPeerJoined: (peer: Readonly<PeerInfo>) => void;

  /**
   * We received a become_coordinator message — take over as coordinator.
   */
  onBecomeCoordinator: (peerList: readonly PeerInfo[]) => void;

  /**
   * A peer announced one already-minted revocation-entry over an established session (management.cddl's revocation-announce, flattened to one call per entry). MeshStore should verify it and, if it verifies, record it in its own RevocationView -- a bearer's already-issued token stays valid to every peer that never received this until it does, per the design's own honest "detection with propagation delay" limit.
   */
  onRevocationAnnounce: (entry: RevocationEntry) => void;

  /**
   * A peer's gossiped self-advert carried a `presence/status` extension (wire-mesh-core's peer-advert open extension tail, re-sent periodically via sendGossipUpdate). Fires only when that key is present and a recognised AgentStatus value -- an advert with no presence extension, or an unrecognised value, is a peer that simply isn't advertising presence over this mechanism, not an error.
   */
  onPresenceAdvert: (
    handle: Readonly<ConnectionHandle>,
    status: AgentStatus,
  ) => void;
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
  startDataServer: () => Promise<void>;

  /**
   * Connect to the coordinator at the given host:port and send an introduction message. Resolves when the connection is established and the introduction has been sent. Rejects if no coordinator is reachable (caller should becomeCoordinator).
   */
  connectToCoordinator: (
    host: string,
    port: number,
    peerId: string,
    dataPort: number,
  ) => Promise<void>;

  /**
   * Start listening as the coordinator on the given host:port. Resolves when the coordinator server is listening.
   */
  becomeCoordinator: (host: string, port: number) => Promise<void>;

  /**
   * Connect to a peer's data server and send a pong identification. Resolves when the connection is established and pong sent. No-op if already connected to this peer.
   */
  connectToPeer: (peer: Readonly<PeerInfo>, ownPeerId: string) => Promise<void>;

  /**
   * Send a wire message to a specific peer connection.
   */
  send: (
    handle: Readonly<ConnectionHandle>,
    message: MeshMessage,
  ) => Promise<void>;

  /**
   * Accept a pending connection. Sends connect_accepted and processes the introduction as normal (peer_list, peer_joined broadcast).
   */
  acceptConnection: (handle: Readonly<ConnectionHandle>) => Promise<void>;

  /**
   * Reject a pending connection. Sends connect_rejected and closes the socket.
   */
  rejectConnection: (
    handle: Readonly<ConnectionHandle>,
    reason: string,
  ) => Promise<void>;

  /**
   * Initiate an outbound connection that requires approval. Sends connect_request instead of introduce and waits for connect_accepted or connect_rejected from the remote coordinator.
   */
  connectToRemote: (options: Readonly<ConnectToRemoteOptions>) => Promise<void>;

  /**
   * Broadcast a wire message to all connected peer data connections.
   */
  broadcast: (message: MeshMessage) => Promise<void>;

  /**
   * Announces one or more already-minted revocation-entries to every connected peer session, best-effort (an unreachable peer misses it and learns of the revocation later, if ever -- the same honest gossip-propagation-delay limit every other broadcast in this codebase already accepts).
   */
  broadcastRevocation: (entries: readonly RevocationEntry[]) => Promise<void>;

  /**
   * Sends a real core/room manage-request to a specific member's own established session, returning its outcome (e.g. a room.join request's granted-token, or a room.send's delivery receipt) rather than swallowing it the way send() does for the legacy opaque-frame path. Resolves to a not_connected error outcome if no live session to that member exists, rather than throwing -- the caller (currently room-join, and P3.5's directed fan-out once it lands) decides how to react to an unreachable member.
   */
  sendRoomRequest: (
    memberId: string,
    command: ManageCommand,
    scope: Readonly<CapabilityScope>,
    token?: CapabilityToken,
  ) => Promise<ManageOutcome>;

  /**
   * Add a coordinator listener on a specific adapter. Only valid when this instance is the coordinator. Returns listener ID.
   */
  addListener: (
    host: string,
    port: number,
    policy: ListenerPolicy,
  ) => Promise<string>;

  /**
   * Remove a listener by ID. Cannot remove the default localhost listener.
   */
  removeListener: (id: string) => Promise<void>;

  /** List all active listeners. */
  listListeners: () => ListenerInfo[];

  /**
   * Gracefully shut down all servers and connections. After shutdown, no further callbacks will fire.
   */
  shutdown: () => Promise<void>;

  /**
   * Unref all root handles so the event loop can exit when the agent process shuts down. Sockets still function for I/O but don't keep the process alive.
   */
  unref: () => void;

  /**
   * Every device this side has ever heard gossip from, mesh-wide, with each one's own latest full advert (any open-extension field such as room/hosted). Optional: WireMeshTransport is the only implementation that offers it today (agent-comms#48/#50's own gossip-directory aggregation), so a caller (listRooms' own room-discovery merge) must treat its absence as "nothing to merge," never assume every MeshTransport has it.
   */
  listKnownDevices?: () => readonly {
    deviceId: string;
    advert: Readonly<Record<string, unknown>>;
  }[];

  /**
   * Dials the relay hub at the given URL and holds the connection (agent-comms#154's own gateway role, riding this side's HubSession -- see hub-session.ts's class doc for the connection model). Optional: WireMeshTransport is the only implementation that offers it today, matching listKnownDevices' own precedent, so a caller (CoordinatorGateway) must treat its absence as "this transport has no gateway capability," never assume every MeshTransport supports it.
   */
  connectHub?: (url: string) => Promise<void>;

  /**
   * Drops this side's own held hub connection, if any. A no-op when none is live. Same optionality caveat as connectHub.
   */
  disconnectHub?: () => Promise<void>;

  /**
   * Asks deviceId for its own, currently-running wire-mesh-core version, live, right now rather than whatever it last gossiped (agent-comms#198's own cache-bust query_version action). Optional, same caveat as listKnownDevices/connectHub: WireMeshTransport is the only implementation that offers it today, riding wire-mesh-core's own version.get manage-command (wire-mesh#179).
   */
  queryVersion?: (deviceId: string) => Promise<ManageOutcome>;

  /**
   * Assembles this side's own best-effort view of the mesh's connection graph (agent-comms#199) out of every device's own self-reported `topology/peers` gossip extension (wire-mesh#180) -- the cheap, possibly-stale counterpart to meshTrace's own live read. Device-ids throughout are hex strings (matching listKnownDevices' own precedent), never raw wire-mesh-core DeviceId bytes. Same optionality caveat as listKnownDevices/connectHub.
   */
  meshGraph?: () => MeshGraph;

  /**
   * Sends the wire-level path.trace manage-command (wire-mesh#181) to a specific device-id, direct or via the hub, and measures the real end-to-end round trip -- the live, cache-bust counterpart to meshGraph's gossiped snapshot. Resolves an error-shaped MeshTraceResult.outcome (never rejects) when targetDeviceHex is unreachable through any known path, mirroring sendRoomRequest's own not_connected convention. Same optionality caveat as listKnownDevices/connectHub.
   */
  meshTrace?: (
    targetDeviceHex: string,
    timeoutMs?: number,
  ) => Promise<MeshTraceResult>;
}

// ---------------------------------------------------------------------------
// Mesh topology graph and path trace (agent-comms#199)
// ---------------------------------------------------------------------------

export interface MeshGraphEdge {
  kind: "direct" | "relay";
  from: string;
  to: string;
  /** The hub device-id this relay edge is reached via, when known -- absent for a "direct" edge, and for a "relay" edge whose hub is a bare, identity-less relay (wire-mesh-node/cloudflare-hub's own RelayHub) with no device-id of its own to report. */
  via?: string;
}

export interface MeshGraph {
  nodes: string[];
  edges: MeshGraphEdge[];
}

export interface MeshTraceLocal {
  relayed: boolean;
  hubAddress?: string;
}

export interface MeshTraceRemote {
  relayed: boolean;
  hubAddress?: string;
}

export interface MeshTraceResult {
  /** Real end-to-end round-trip time in milliseconds. */
  rttMs: number;
  local: MeshTraceLocal;
  /** The receiver's own reported relayed/hub-address -- absent when outcome is an error rather than a successful path-trace-ok. */
  remote?: MeshTraceRemote;
  outcome: ManageOutcome;
}

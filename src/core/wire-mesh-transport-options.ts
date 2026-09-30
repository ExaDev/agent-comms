/**
 * WireMeshTransport's own constructor options, split out purely to keep wire-mesh-transport.ts under the repo's max-lines cap, the same reason connection-approval.ts, room-router.ts, hub-session.ts, peer-lifecycle.ts, gossip-directory.ts, and listener-registry.ts were each split from that file.
 */

import type { KeyValueStorage } from "wire-mesh-core/ports/storage";
import type { GatewayTrustReader } from "./gateway-trust.js";
import type { RoomVerbHandler } from "./room-router.js";
import type { AgentStatus } from "./types.js";
import type { AgentSelfAdvert, HostedRoomAdvert } from "./gossip-extensions.js";
import type { ListenerPolicy } from "./transport.js";

/** roomVerbHandlers, getCurrentPresence, getHostedRooms, dataStorage, getSelfAgentAdvert, and gatewayTrust each match the field-level doc comment on the WireMeshTransport field they back; pendingConnectionTimeoutMs and presenceReadvertiseIntervalMs default to DEFAULT_PENDING_CONNECTION_TIMEOUT_MS/PRESENCE_READVERTISE_INTERVAL_MS. All eight are optional and bundled into this one options type -- a caller needing only gatewayTrust no longer has to pass `undefined` for every one before it. */
export interface WireMeshTransportOptions {
  roomVerbHandlers?: Partial<Record<string, RoomVerbHandler>>;
  pendingConnectionTimeoutMs?: number | undefined;
  /** How long a room.join this transport sends may await a human decision at the receiving end. Defaults to ROOM_JOIN_APPROVAL_TIMEOUT_MS; a test shortens it. */
  roomJoinApprovalTimeoutMs?: number | undefined;
  getCurrentPresence?: () => AgentStatus | undefined;
  presenceReadvertiseIntervalMs?: number | undefined;
  getHostedRooms?: () => readonly HostedRoomAdvert[];
  dataStorage?: KeyValueStorage;
  getSelfAgentAdvert?: () => AgentSelfAdvert | undefined;
  gatewayTrust?: Readonly<GatewayTrustReader>;
  /** Checks a gossiped membership proof against a principal or machine this side trusts (MembershipProofs.verify). Without it, a directory entry from a device not trusted by id is refused even when it carries a proof. */
  verifyMembership?: (
    claim: Readonly<{ proof: string; deviceHex: string; issuerHex: string }>,
  ) => Promise<{ ok: true; expires: number } | { ok: false; reason: string }>;
}

/** WireMeshTransport.connectToRemote's own bundled parameters -- see MeshTransport's own connectToRemote doc comment (transport.ts) for what each one means. */
export interface ConnectToRemoteOptions {
  host: string;
  port: number;
  peerId: string;
  dataPort: number;
  name: string;
  fingerprint: string;
}

/** How an accepted connection is treated, set by the listener that accepted it. fireOnPeerConnected is true only for the data server, whose connections are a known peer's own data dial; requiresApproval quarantines a listener a stranger can dial cold; machineLocal marks a loopback-only listener, whose sessions take part in the coordinator election (election-sessions.ts). */
export interface AcceptOptions {
  policy: ListenerPolicy | undefined;
  fireOnPeerConnected: boolean;
  requiresApproval: boolean;
  machineLocal: boolean;
}

/** The data server: bound on loopback, dialled only by peers that already know its port. */
export const DATA_SERVER_ACCEPT: Readonly<AcceptOptions> = {
  policy: undefined,
  fireOnPeerConnected: true,
  requiresApproval: false,
  machineLocal: true,
};

/** The default well-known port listener: bound on loopback, but dialled cold, so quarantined until an introduce or an approved connect_request. */
export const DEFAULT_LISTENER_ACCEPT: Readonly<AcceptOptions> = {
  policy: "full",
  fireOnPeerConnected: false,
  requiresApproval: true,
  machineLocal: true,
};

/** A listener an operator added with addListener: on whatever interface they chose, so it may cross machines and never carries coordinator claims. */
export function operatorListenerAccept(policy: ListenerPolicy): AcceptOptions {
  return {
    policy,
    fireOnPeerConnected: false,
    requiresApproval: true,
    machineLocal: false,
  };
}

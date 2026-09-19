/**
 * WireMeshTransport's own constructor options, split out purely to keep wire-mesh-transport.ts under the repo's max-lines cap, the same reason connection-approval.ts, room-router.ts, hub-session.ts, peer-lifecycle.ts, gossip-directory.ts, and listener-registry.ts were each split from that file.
 */

import type { KeyValueStorage } from "wire-mesh-core/ports/storage";
import type { GatewayTrustReader } from "./gateway-trust.js";
import type { RoomVerbHandler } from "./room-router.js";
import type { AgentStatus } from "./types.js";
import type { AgentSelfAdvert, HostedRoomAdvert } from "./gossip-extensions.js";

/** roomVerbHandlers, getCurrentPresence, getHostedRooms, dataStorage, getSelfAgentAdvert, and gatewayTrust each match the field-level doc comment on the WireMeshTransport field they back; pendingConnectionTimeoutMs and presenceReadvertiseIntervalMs default to DEFAULT_PENDING_CONNECTION_TIMEOUT_MS/PRESENCE_READVERTISE_INTERVAL_MS. All eight are optional and bundled into this one options type -- a caller needing only gatewayTrust no longer has to pass `undefined` for every one before it. */
export interface WireMeshTransportOptions {
  roomVerbHandlers?: Partial<Record<string, RoomVerbHandler>>;
  pendingConnectionTimeoutMs?: number | undefined;
  getCurrentPresence?: () => AgentStatus | undefined;
  presenceReadvertiseIntervalMs?: number | undefined;
  getHostedRooms?: () => readonly HostedRoomAdvert[];
  dataStorage?: KeyValueStorage;
  getSelfAgentAdvert?: () => AgentSelfAdvert | undefined;
  gatewayTrust?: Readonly<GatewayTrustReader>;
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

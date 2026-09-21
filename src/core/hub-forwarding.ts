/**
 * hub-forwarding -- local-to-remote routing, split from wire-mesh-transport.ts under the repo's max-lines cap: falls a room-domain request back through the hub's own relay-connect/relay-data pairing when its target isn't a local peer session.
 */

import type {
  CapabilityScope,
  CapabilityToken,
  ManageCommand,
} from "wire-mesh-core/generated/protocol";
import type { ManageOutcome } from "wire-mesh-core/domain/mesh-session";
import type { HubSession } from "./hub-session.js";

/** Routes a room-domain request through the hub's relay-connect/relay-data pairing when memberId isn't a local peer session -- WireMeshTransport.sendRoomRequest's own fallback, since the member may be a remote agent reachable only through the hub this store is connected to (agent-comms#155's local-to-remote leg). WireMeshTransport.sendRoomRequest itself gates memberId against the gateway trust boundary (agent-comms#156) before ever calling this, so by the time this runs memberId is already known-trusted -- this function stays focused on the hub-connectivity outcome alone. Resolves the same not_connected outcome sendRoomRequest already returned before the hub existed at all when this side isn't currently the gateway. */
export async function routeRoomRequestViaHub(options: {
  hub: Readonly<Pick<HubSession, "isConnected" | "sendRoomRequest">>;
  memberId: string;
  command: ManageCommand;
  scope: Readonly<CapabilityScope>;
  token?: CapabilityToken | undefined;
}): Promise<ManageOutcome> {
  const { hub, memberId, command, scope, token } = options;
  if (!hub.isConnected) return { result: "error", code: "not_connected" };
  return hub.sendRoomRequest(memberId, command, scope, token);
}

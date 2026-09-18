/**
 * mesh-graph -- agent-comms#199's own mesh_graph/mesh_trace primitives, split from wire-mesh-transport.ts under the repo's max-lines cap, the same reason gossip-directory.ts/hub-forwarding.ts were each split from their own owning file. computeMeshGraph assembles this side's best-effort view of the mesh's connection graph out of every known device's own self-reported topology/peers gossip extension (wire-mesh#180); traceMeshPath sends the live path.trace verb (wire-mesh#181) to a specific device, direct or via the hub.
 */

import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { assembleTopologyGraph } from "wire-mesh-core/domain/topology";
import {
  buildPathTraceResponse,
  tracePath,
} from "wire-mesh-core/domain/path-trace";
import type {
  AcceptedMeshSession,
  DirectoryEntry,
  IncomingManageRequest,
  ManageOutcome,
} from "wire-mesh-core/domain/mesh-session";
import type { PeerAdvert } from "wire-mesh-core/generated/protocol";
import type { HubSession } from "./hub-session.js";
import type { MeshGraph, MeshTraceResult } from "./transport.js";

/** Assembles this side's own best-effort view of the mesh's connection graph out of knownDevices (WireMeshTransport's own mesh-wide gossip aggregation, the identical map listKnownDevices already reads), converted to DirectoryEntry[] the same way hub-forwarding.ts's own pushHubCatchUp already does for its unrelated purpose. Device-ids are hex-encoded, never raw wire-mesh-core DeviceId bytes, matching listKnownDevices' own precedent. */
export function computeMeshGraph(
  knownDevices: ReadonlyMap<string, Readonly<PeerAdvert>>,
): MeshGraph {
  const directory: DirectoryEntry[] = [...knownDevices.values()].map(
    (advert) => ({ device: advert.device, advert }),
  );
  const graph = assembleTopologyGraph(directory);
  return {
    nodes: graph.nodes.map(deviceIdToHex),
    edges: graph.edges.map((edge) => ({
      kind: edge.kind,
      from: deviceIdToHex(edge.from),
      to: deviceIdToHex(edge.to),
      ...(edge.kind === "relay" && edge.via !== undefined
        ? { via: deviceIdToHex(edge.via) }
        : {}),
    })),
  };
}

/** Sends path.trace to targetDeviceHex, direct if a local peer session exists for it (peerSessions, WireMeshTransport's own addressing map), else via the hub's own relay pairing when connected to one, else resolving an ordinary not_connected outcome rather than throwing -- WireMeshTransport.sendRoomRequest's own identical direct-or-hub fallback, just for path.trace instead of a room-domain verb. Delegates the actual send/RTT-measurement/response-parsing to wire-mesh-core's own tracePath in the direct branch, and to HubSession.tracePath (which does the identical delegation on the hub's own session) in the relayed branch, so neither this function nor either of those duplicates that logic. */
export async function traceMeshPath(
  peerSessions: ReadonlyMap<string, AcceptedMeshSession>,
  hub: Readonly<Pick<HubSession, "isConnected" | "tracePath">>,
  targetDeviceHex: string,
  timeoutMs?: number,
): Promise<MeshTraceResult> {
  const directSession = peerSessions.get(targetDeviceHex);
  if (directSession !== undefined) {
    return tracePath({
      session: directSession,
      clock: { now: () => Date.now() },
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  }
  if (hub.isConnected) {
    return hub.tracePath(targetDeviceHex, timeoutMs);
  }
  return {
    rttMs: 0,
    local: { relayed: false },
    outcome: { result: "error", code: "not_connected" },
  };
}

/** Answers an incoming path.trace (agent-comms#199), registered as this side's own "path.trace" room-router handler (createRoomRouter's handlers are keyed by params.verb regardless of domain, despite the room-flavoured name -- see WireMeshTransport's own constructor for where this is wired in alongside the real room verbs). Omits hubAddress unconditionally: RoomVerbHandler's own (request, handle) signature carries no reference to which raw session/connection the request arrived on, so there is no way to look up "the address this side dialled to reach the hub that relayed it" from here -- buildPathTraceResponse's own hubAddress parameter is optional exactly for a receiver with no address to report, so this is an honest omission, not a workaround. Tracked as agent-comms#216 for a future RoomVerbHandler signature change that would let this report it. */
export async function handlePathTraceRequest(
  request: Readonly<IncomingManageRequest>,
): Promise<ManageOutcome> {
  return Promise.resolve(buildPathTraceResponse(request));
}

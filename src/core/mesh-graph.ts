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
import type { RoomRequestOrigin } from "./room-router.js";
import type {
  ConnectionHandle,
  MeshGraph,
  MeshTraceResult,
} from "./transport.js";

/**
 * Assembles this side's own best-effort view of the mesh's connection graph out of knownDevices (WireMeshTransport's own mesh-wide gossip aggregation, the identical map listKnownDevices already reads), converted to DirectoryEntry[] the same way hub-forwarding.ts's own pushHubCatchUp already does for its unrelated purpose. Device-ids are hex-encoded, never raw wire-mesh-core DeviceId bytes, matching listKnownDevices' own precedent.
 *
 * assembleTopologyGraph's own nodes list is only devices this side holds a directory entry (gossip advert) for -- its edges are deliberately "unreconciled by design" (see its own doc comment) and can name a `to`/`via` endpoint reported by another device's advert that this side has never itself gossiped with directly, so that endpoint never gets its own directory entry and is absent from nodes. A MeshGraph whose edges reference an undeclared node isn't well-formed for any consumer (a force-directed layout, a table, anything), so every edge endpoint is unioned into the returned nodes list here, not left for each consumer to work around individually.
 */
export function computeMeshGraph(
  knownDevices: ReadonlyMap<string, Readonly<PeerAdvert>>,
): MeshGraph {
  const directory: DirectoryEntry[] = [...knownDevices.values()].map(
    (advert) => ({ device: advert.device, advert }),
  );
  const graph = assembleTopologyGraph(directory);
  const edges = graph.edges.map((edge) => ({
    kind: edge.kind,
    from: deviceIdToHex(edge.from),
    to: deviceIdToHex(edge.to),
    ...(edge.kind === "relay" && edge.via !== undefined
      ? { via: deviceIdToHex(edge.via) }
      : {}),
  }));
  const nodes = new Set(graph.nodes.map(deviceIdToHex));
  for (const edge of edges) {
    nodes.add(edge.from);
    nodes.add(edge.to);
    if (edge.via !== undefined) nodes.add(edge.via);
  }
  return { nodes: [...nodes], edges };
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

/** Answers an incoming path.trace (agent-comms#199), registered as this side's own "path.trace" room-router handler (createRoomRouter's handlers are keyed by params.verb regardless of domain, despite the room-flavoured name -- see WireMeshTransport's own constructor for where this is wired in alongside the real room verbs). Reports origin?.relayHubAddress (agent-comms#216) as buildPathTraceResponse's own hubAddress parameter -- that function itself already gates inclusion on the request actually being relayed (request.fromDevice set), so this passes it through unconditionally rather than duplicating that check here; handle is unused, kept only to occupy RoomVerbHandler's own positional slot ahead of origin. */
export async function handlePathTraceRequest(
  request: Readonly<IncomingManageRequest>,
  _handle: Readonly<ConnectionHandle>,
  origin?: Readonly<RoomRequestOrigin>,
): Promise<ManageOutcome> {
  return Promise.resolve(
    buildPathTraceResponse(request, origin?.relayHubAddress),
  );
}

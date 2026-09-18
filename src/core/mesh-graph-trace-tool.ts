/**
 * CommsTool's mesh_graph/mesh_trace action handlers (agent-comms#199) -- split out of tool.ts purely to keep that file under the repo's max-lines cap, the same reason gateway-trust-actions.ts/connection-code-tool.ts were split from it. Free functions over MeshOnlyFeatures's own meshGraph/meshTrace methods rather than class methods, since CommsTool owns no state of its own for this concern.
 */

import type { CommsAction } from "./types.js";
import type { CommsResult, MeshOnlyFeatures } from "./tool.js";
import { tryMeshAction } from "./tool.js";

/** Column width the "direct"/"relay" edge-kind label is padded to in meshGraphAction's own listing, matching tool.ts's own aligned-column convention for every other tabular action result. */
const MESH_GRAPH_EDGE_KIND_COLUMN_WIDTH = 6;

/** Uniform "this bridge isn't backed by a mesh transport" result, mirroring tool.ts's own notMeshBacked for the other MeshOnlyFeatures methods (not exported from there, so re-declared locally the same way gateway-trust-actions.ts's own gatewayTrustUnavailable already does). */
function meshFeatureUnavailable(action: string): CommsResult {
  return {
    isError: true,
    content: `${action} requires a mesh-backed store (this session is running on FileStore)`,
  };
}

/** Reports every known device (nodes) and every self-reported connection edge between them (edges), assembled from the cached gossip directory -- a cheap, possibly-stale snapshot; meshTraceAction below is the live, cache-bust counterpart for one specific device. */
export function meshGraphAction(
  store: Readonly<Pick<MeshOnlyFeatures, "meshGraph">>,
): CommsResult {
  if (!store.meshGraph) return meshFeatureUnavailable("mesh_graph");
  const graph = store.meshGraph();
  if (graph.nodes.length === 0)
    return { content: "No known devices in the mesh graph.", isError: false };

  const edgeLines = graph.edges.map((edge) => {
    const via =
      edge.kind === "relay" && edge.via !== undefined ? ` via ${edge.via}` : "";
    return `  ${edge.kind.padEnd(MESH_GRAPH_EDGE_KIND_COLUMN_WIDTH)} ${edge.from} -> ${edge.to}${via}`;
  });
  const edgesBlock =
    edgeLines.length > 0 ? edgeLines.join("\n") : "  (no edges reported)";
  return {
    content: `Mesh graph:\nNodes (${String(graph.nodes.length)}): ${graph.nodes.join(", ")}\nEdges:\n${edgesBlock}`,
    isError: false,
  };
}

/** Sends path.trace to action.target and reports the real end-to-end RTT plus each side's own relayed/hub-address knowledge -- the live counterpart to meshGraphAction's gossiped snapshot. */
export async function meshTraceAction(
  store: Readonly<Pick<MeshOnlyFeatures, "meshTrace">>,
  action: CommsAction & { action: "mesh_trace" },
): Promise<CommsResult> {
  if (!store.meshTrace) return meshFeatureUnavailable("mesh_trace");
  return tryMeshAction(`trace ${action.target}`, async () => {
    // Called via `?.()` rather than a `const meshTrace = store.meshTrace` extraction -- the latter would silently drop `this` (WireMeshTransport.meshTrace reads its own private fields), a real bug this exact pattern caught during development. TypeScript can't carry the `if (!store.meshTrace)` guard above across this closure boundary, so `result` is still typed possibly-undefined even though it never actually is at runtime.
    const result = await store.meshTrace?.(action.target, action.timeoutMs);
    if (!result) return meshFeatureUnavailable("mesh_trace").content;
    if (result.outcome.result === "error") {
      throw new Error(
        `${result.outcome.code}${result.outcome.message !== undefined ? `: ${result.outcome.message}` : ""}`,
      );
    }
    const localHub =
      result.local.hubAddress !== undefined
        ? ` (hub ${result.local.hubAddress})`
        : "";
    const lines = [
      `Trace to ${action.target}:`,
      `  RTT: ${String(result.rttMs)}ms`,
      `  Local:  ${result.local.relayed ? "relayed" : "direct"}${localHub}`,
    ];
    if (result.remote) {
      const remoteHub =
        result.remote.hubAddress !== undefined
          ? ` (hub ${result.remote.hubAddress})`
          : "";
      lines.push(
        `  Remote: ${result.remote.relayed ? "relayed" : "direct"}${remoteHub}`,
      );
    }
    return lines.join("\n");
  });
}

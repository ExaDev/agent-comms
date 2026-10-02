/**
 * The mesh-introspection reads MeshStore exposes over its transport (listener policy parsing, mesh graph, path trace), each failing with a typed CommsError when the transport lacks the capability.
 */

import { CommsError } from "./store.js";
import type {
  ListenerPolicy,
  MeshGraph,
  MeshTraceResult,
  MeshTransport,
} from "./transport.js";

function isListenerPolicy(v: string): v is ListenerPolicy {
  return (
    v === "full" || v === "observe" || v === "rooms-only" || v === "gateway"
  );
}

/** Narrows a caller-supplied policy string, throwing INVALID_POLICY for anything the transport does not define. */
export function parseListenerPolicy(policy: string): ListenerPolicy {
  if (!isListenerPolicy(policy)) {
    throw new CommsError(`Invalid policy "${policy}"`, "INVALID_POLICY");
  }
  return policy;
}

/** The transport's own meshGraph (agent-comms#199), throwing NOT_SUPPORTED if it has none. */
export function requireMeshGraph(
  transport: Readonly<MeshTransport>,
): MeshGraph {
  const graph = transport.meshGraph?.();
  if (graph === undefined) {
    throw new CommsError(
      "mesh_graph requires a transport that supports it",
      "NOT_SUPPORTED",
    );
  }
  return graph;
}

/** The transport's own meshTrace, throwing NOT_SUPPORTED if it has none. */
export async function requireMeshTrace(
  transport: Readonly<MeshTransport>,
  target: string,
  timeoutMs?: number,
): Promise<MeshTraceResult> {
  if (transport.meshTrace === undefined) {
    throw new CommsError(
      "mesh_trace requires a transport that supports it",
      "NOT_SUPPORTED",
    );
  }
  return transport.meshTrace(target, timeoutMs);
}

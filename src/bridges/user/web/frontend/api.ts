/**
 * API client — typed REST communication with the comms server.
 *
 * REST for initial data fetches and the /api/action test-scaffolding endpoint. Real-time state, patches, actions, and delivery events all go through MeshClient/mesh-client.ts's own oRPC client now -- this file no longer carries a WebSocket client of its own. All methods are typed against the interfaces in types.ts.
 *
 * JSON boundaries use runtime validation with type predicates — no assertions.
 */

import type {
  Action,
  ActionResult,
  AgentsResponse,
  MeshGraph,
  MeshTraceResult,
  MessagesResponse,
  RoomsResponse,
} from "./types.js";

// ---------------------------------------------------------------------------
// Runtime type validators (no Zod in browser bundle)
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAgentsResponse(value: unknown): value is AgentsResponse {
  return Array.isArray(value);
}

function isRoomsResponse(value: unknown): value is RoomsResponse {
  return Array.isArray(value);
}

function isMessagesResponse(value: unknown): value is MessagesResponse {
  return Array.isArray(value);
}

function isActionResult(value: unknown): value is ActionResult {
  if (!isObject(value)) return false;
  return (
    typeof value.content === "string" && typeof value.isError === "boolean"
  );
}

function isMeshGraph(value: unknown): value is MeshGraph {
  return (
    isObject(value) && Array.isArray(value.nodes) && Array.isArray(value.edges)
  );
}

function isMeshTraceResult(value: unknown): value is MeshTraceResult {
  if (!isObject(value)) return false;
  if (typeof value.rttMs !== "number") return false;
  if (!isObject(value.local)) return false;
  if (!isObject(value.outcome)) return false;
  return typeof value.outcome.result === "string";
}

// ---------------------------------------------------------------------------
// REST client
// ---------------------------------------------------------------------------

export async function fetchAgents(): Promise<AgentsResponse> {
  const res = await fetch("/api/agents");
  const body: unknown = await res.json();
  if (!isAgentsResponse(body)) throw new Error("Invalid agents response");
  return body;
}

export async function fetchRooms(): Promise<RoomsResponse> {
  const res = await fetch("/api/rooms");
  const body: unknown = await res.json();
  if (!isRoomsResponse(body)) throw new Error("Invalid rooms response");
  return body;
}

export async function fetchRoomMessages(
  roomId: string,
  since?: string,
): Promise<MessagesResponse> {
  const url =
    since !== undefined
      ? `/api/rooms/${encodeURIComponent(roomId)}/messages?since=${encodeURIComponent(since)}`
      : `/api/rooms/${encodeURIComponent(roomId)}/messages`;
  const res = await fetch(url);
  const body: unknown = await res.json();
  if (!isMessagesResponse(body)) throw new Error("Invalid messages response");
  return body;
}

/** Reads server.ts's mesh endpoints' own jsonError response body (an "error" string field), falling back to the response's own status text when the body isn't the expected shape (e.g. a network-level failure with no JSON body at all). */
async function readMeshErrorMessage(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (isObject(body) && typeof body.error === "string") return body.error;
  } catch {
    // fall through to statusText below
  }
  return res.statusText || `HTTP ${String(res.status)}`;
}

export async function fetchMeshGraph(): Promise<MeshGraph> {
  const res = await fetch("/api/mesh/graph");
  if (!res.ok) throw new Error(await readMeshErrorMessage(res));
  const body: unknown = await res.json();
  if (!isMeshGraph(body)) throw new Error("Invalid mesh graph response");
  return body;
}

export async function fetchMeshTrace(
  target: string,
  timeoutMs?: number,
): Promise<MeshTraceResult> {
  const params = new URLSearchParams({ target });
  if (timeoutMs !== undefined) params.set("timeoutMs", String(timeoutMs));
  const res = await fetch(`/api/mesh/trace?${params.toString()}`);
  if (!res.ok) throw new Error(await readMeshErrorMessage(res));
  const body: unknown = await res.json();
  if (!isMeshTraceResult(body)) throw new Error("Invalid mesh trace response");
  return body;
}

export async function postAction(action: Action): Promise<ActionResult> {
  const res = await fetch("/api/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(action),
  });
  const body: unknown = await res.json();
  if (!isActionResult(body)) throw new Error("Invalid action result");
  return body;
}

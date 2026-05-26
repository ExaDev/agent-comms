/**
 * RelayWorker — SharedWorker that connects two mesh WebSocket endpoints
 * and forwards wire messages between them with filtering and peer ID
 * translation.
 *
 * Two isolated meshes can communicate through the browser without direct
 * network connectivity between them. Peer IDs are prefixed with a mesh
 * label ("a:" or "b:") to avoid collisions between the two meshes.
 *
 * Built as a separate IIFE bundle (relay-worker.js) so the SharedWorker
 * runs in its own global scope independent of the main app and mesh-worker
 * bundles.
 */

// ---------------------------------------------------------------------------
// SharedWorker environment types (self-contained, no external imports)
// ---------------------------------------------------------------------------

interface SharedWorkerGlobalScope {
  addEventListener(type: "connect", listener: (event: MessageEvent) => void): void;
  close(): void;
}

interface MessagePortLike {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: MessageEvent) => void) | null;
}

declare const self: SharedWorkerGlobalScope;

// ---------------------------------------------------------------------------
// Wire protocol types (inlined — mirrors core/wire-protocol.ts)
// ---------------------------------------------------------------------------

interface AgentIdentity {
  id: string;
  name: string;
  harness: string;
  cwd: string;
  pid: number;
  startedAt: string;
  visibility: "visible" | "hidden" | "ghost";
  status: "active" | "idle" | "busy" | "offline";
  tags: string[];
  subscribedRooms: string[];
}

interface Room {
  id: string;
  name: string;
  type: "public" | "private" | "secret";
  owner: string;
  createdAt: string;
  description: string;
  members: string[];
  invited: string[];
}

interface RoomMessage {
  id: string;
  from: string;
  room: string;
  content: string;
  timestamp: string;
  replyTo?: string;
  readBy: string[];
}

interface DmMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  timestamp: string;
  readBy: string[];
}

interface SerialisedState {
  agents: Record<string, AgentIdentity>;
  rooms: Record<string, Room>;
  messages: Record<string, RoomMessage[]>;
  dms: Record<string, DmMessage[]>;
}

type MeshStatePatch =
  | { type: "agent_upsert"; agent: AgentIdentity }
  | { type: "agent_offline"; agentId: string }
  | { type: "room_upsert"; room: Room }
  | { type: "room_delete"; roomId: string }
  | { type: "message_add"; roomId: string; message: RoomMessage }
  | { type: "dm_add"; key: string; message: DmMessage }
  | { type: "delivery"; agentId: string; event: { type: string; [key: string]: unknown } }
  | { type: "message_read"; messageId: string; readBy: string; room?: string };

// ---------------------------------------------------------------------------
// Wire message (subset — only what the relay needs to handle)
// ---------------------------------------------------------------------------

interface WireMessage {
  method: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Main-thread ↔ Worker message protocol
// ---------------------------------------------------------------------------

type RelayInbound =
  | { type: "connect"; urlA: string; urlB: string }
  | { type: "disconnect" }
  | { type: "status" };

interface RelayStatus {
  connectedA: boolean;
  connectedB: boolean;
  urlA: string | undefined;
  urlB: string | undefined;
  forwardedCount: number;
  errors: string[];
}

type RelayOutbound =
  | { type: "status"; status: RelayStatus }
  | { type: "error"; message: string };

// ---------------------------------------------------------------------------
// Relay state
// ---------------------------------------------------------------------------

/** Methods that should be forwarded between meshes. */
const FORWARDABLE_METHODS = new Set([
  "state_update",
  "peer_joined",
  "peer_left",
]);

/** Methods that must never be forwarded (cause loops or are side-specific). */
const BLOCKED_METHODS = new Set([
  "state_sync",
  "introduce",
  "connect_request",
  "connect_accepted",
  "connect_rejected",
  "peer_list",
  "become_coordinator",
  "pong",
  "fed_handshake",
  "fed_ack",
  "fed_agent_visible",
  "fed_agent_gone",
  "fed_room_message",
  "fed_room_join",
  "fed_room_leave",
  "fed_ping",
  "fed_pong",
]);

interface MeshConnection {
  label: "a" | "b";
  url: string;
  ws: WebSocket | undefined;
  connected: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | undefined;
}

const meshA: MeshConnection = {
  label: "a",
  url: "",
  ws: undefined,
  connected: false,
  reconnectTimer: undefined,
};

const meshB: MeshConnection = {
  label: "b",
  url: "",
  ws: undefined,
  connected: false,
  reconnectTimer: undefined,
};

let forwardedCount = 0;
const errors: string[] = [];
const MAX_ERRORS = 50;

const ports = new Set<MessagePortLike>();

// ---------------------------------------------------------------------------
// Peer ID translation
// ---------------------------------------------------------------------------

function prefixId(label: "a" | "b", id: string): string {
  return `${label}:${id}`;
}

function translateAgent(label: "a" | "b", agent: AgentIdentity): AgentIdentity {
  return {
    ...agent,
    id: prefixId(label, agent.id),
    name: `${agent.name} (via ${label.toUpperCase()})`,
    subscribedRooms: agent.subscribedRooms.map((r) => prefixId(label, r)),
  };
}

function translateRoom(label: "a" | "b", room: Room): Room {
  return {
    ...room,
    id: prefixId(label, room.id),
    owner: prefixId(label, room.owner),
    members: room.members.map((m) => prefixId(label, m)),
    invited: room.invited.map((m) => prefixId(label, m)),
  };
}

function translateMessage(label: "a" | "b", msg: RoomMessage): RoomMessage {
  return {
    ...msg,
    from: prefixId(label, msg.from),
    room: prefixId(label, msg.room),
    readBy: msg.readBy.map((r) => prefixId(label, r)),
    replyTo: msg.replyTo ? prefixId(label, msg.replyTo) : undefined,
  };
}

function translateDm(label: "a" | "b", msg: DmMessage): DmMessage {
  return {
    ...msg,
    from: prefixId(label, msg.from),
    to: prefixId(label, msg.to),
    readBy: msg.readBy.map((r) => prefixId(label, r)),
  };
}

function translateDmKey(label: "a" | "b", key: string): string {
  // DM keys are "idA--idB" (sorted). Prefix both IDs.
  const parts = key.split("--");
  return parts.map((p) => prefixId(label, p)).join("--");
}

/**
 * Translate a state_update patch, prefixing all peer/room IDs with the
 * mesh label so they don't collide with IDs from the other mesh.
 */
function translatePatch(label: "a" | "b", patch: MeshStatePatch): MeshStatePatch {
  switch (patch.type) {
    case "agent_upsert":
      return { ...patch, agent: translateAgent(label, patch.agent) };
    case "agent_offline":
      return { ...patch, agentId: prefixId(label, patch.agentId) };
    case "room_upsert":
      return { ...patch, room: translateRoom(label, patch.room) };
    case "room_delete":
      return { ...patch, roomId: prefixId(label, patch.roomId) };
    case "message_add":
      return { ...patch, roomId: prefixId(label, patch.roomId), message: translateMessage(label, patch.message) };
    case "dm_add":
      return { ...patch, key: translateDmKey(label, patch.key), message: translateDm(label, patch.message) };
    case "delivery":
      return { ...patch, agentId: prefixId(label, patch.agentId) };
    case "message_read":
      return {
        ...patch,
        readBy: prefixId(label, patch.readBy),
        ...(patch.room ? { room: prefixId(label, patch.room) } : {}),
      };
  }
}

// ---------------------------------------------------------------------------
// Wire message parsing
// ---------------------------------------------------------------------------

function parseWireMessage(raw: unknown): WireMessage | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  if (!("method" in raw)) return undefined;
  if (typeof (raw as Record<string, unknown>).method !== "string") return undefined;
  return raw as WireMessage;
}

// ---------------------------------------------------------------------------
// Message forwarding
// ---------------------------------------------------------------------------

function shouldForward(msg: WireMessage): boolean {
  if (BLOCKED_METHODS.has(msg.method)) return false;
  if (FORWARDABLE_METHODS.has(msg.method)) return true;
  // Unknown methods are blocked by default
  return false;
}

function translateWireMessage(label: "a" | "b", msg: WireMessage): WireMessage {
  if (msg.method === "state_update") {
    const patch = msg.patch as MeshStatePatch;
    return { ...msg, patch: translatePatch(label, patch) };
  }
  if (msg.method === "peer_joined") {
    const peer = msg.peer as { id: string; port: number; startedAt: string };
    return {
      ...msg,
      peer: { ...peer, id: prefixId(label, peer.id) },
    };
  }
  if (msg.method === "peer_left") {
    return { ...msg, peerId: prefixId(label, msg.peerId as string) };
  }
  return msg;
}

function forwardToTarget(source: MeshConnection, target: MeshConnection, raw: unknown): void {
  const msg = parseWireMessage(raw);
  if (msg === undefined) return;
  if (!shouldForward(msg)) return;

  const translated = translateWireMessage(source.label, msg);
  const targetWs = target.ws;
  if (targetWs?.readyState === WebSocket.OPEN) {
    targetWs.send(JSON.stringify(translated));
    forwardedCount++;
    broadcastStatus();
  }
}

// ---------------------------------------------------------------------------
// WebSocket connection management
// ---------------------------------------------------------------------------

function connectMesh(conn: MeshConnection, other: MeshConnection): void {
  if (conn.reconnectTimer !== undefined) {
    clearTimeout(conn.reconnectTimer);
    conn.reconnectTimer = undefined;
  }

  const socket = new WebSocket(conn.url);
  conn.ws = socket;

  socket.onopen = () => {
    conn.connected = true;
    broadcastStatus();
  };

  socket.onclose = () => {
    conn.ws = undefined;
    conn.connected = false;
    broadcastStatus();
    scheduleReconnect(conn, other);
  };

  socket.onerror = () => {
    // onclose fires after this
  };

  socket.onmessage = (event: MessageEvent) => {
    const raw: unknown = JSON.parse(
      typeof event.data === "string" ? event.data : String(event.data),
    );
    forwardToTarget(conn, other, raw);
  };
}

function scheduleReconnect(conn: MeshConnection, other: MeshConnection): void {
  if (!conn.url) return;
  conn.reconnectTimer = setTimeout(() => {
    if (conn.url) connectMesh(conn, other);
  }, 3000);
}

function disconnectMesh(conn: MeshConnection): void {
  if (conn.reconnectTimer !== undefined) {
    clearTimeout(conn.reconnectTimer);
    conn.reconnectTimer = undefined;
  }
  conn.ws?.close();
  conn.ws = undefined;
  conn.connected = false;
  conn.url = "";
}

// ---------------------------------------------------------------------------
// Port management — fan-out to all connected main-thread tabs
// ---------------------------------------------------------------------------

function broadcastToPorts(msg: RelayOutbound): void {
  const data = JSON.stringify(msg);
  for (const port of ports) {
    try {
      port.postMessage(data);
    } catch {
      // Port closed
    }
  }
}

function broadcastStatus(): void {
  broadcastToPorts({
    type: "status",
    status: getStatus(),
  });
}

function getStatus(): RelayStatus {
  return {
    connectedA: meshA.connected,
    connectedB: meshB.connected,
    urlA: meshA.url || undefined,
    urlB: meshB.url || undefined,
    forwardedCount,
    errors: [...errors],
  };
}

function addError(message: string): void {
  errors.push(message);
  if (errors.length > MAX_ERRORS) {
    errors.shift();
  }
}

function handlePortMessage(msg: RelayInbound): void {
  switch (msg.type) {
    case "connect": {
      // Disconnect existing connections
      disconnectMesh(meshA);
      disconnectMesh(meshB);
      forwardedCount = 0;
      errors.length = 0;

      meshA.url = msg.urlA;
      meshB.url = msg.urlB;

      try {
        connectMesh(meshA, meshB);
        connectMesh(meshB, meshA);
      } catch (err) {
        addError(err instanceof Error ? err.message : String(err));
      }
      broadcastStatus();
      break;
    }
    case "disconnect": {
      disconnectMesh(meshA);
      disconnectMesh(meshB);
      broadcastStatus();
      break;
    }
    case "status":
      broadcastStatus();
      break;
  }
}

function isRelayInbound(value: unknown): value is RelayInbound {
  if (typeof value !== "object" || value === null) return false;
  if (!("type" in value)) return false;
  const t = (value as Record<string, unknown>).type;
  return t === "connect" || t === "disconnect" || t === "status";
}

// ---------------------------------------------------------------------------
// Entry point — listen for SharedWorker connections
// ---------------------------------------------------------------------------

self.addEventListener("connect", (event: MessageEvent) => {
  const port = event.ports[0] as unknown as MessagePortLike;
  ports.add(port);

  // Send current status to the new port
  try {
    port.postMessage(
      JSON.stringify({ type: "status", status: getStatus() } satisfies RelayOutbound),
    );
  } catch {
    // Port not ready yet
  }

  port.onmessage = (e: MessageEvent) => {
    const parsed: unknown = JSON.parse(
      typeof e.data === "string" ? e.data : String(e.data),
    );
    if (isRelayInbound(parsed)) {
      handlePortMessage(parsed);
    }
  };
});

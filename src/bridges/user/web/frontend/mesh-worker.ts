/**
 * SharedWorker — browser mesh node.
 *
 * Runs a lightweight mesh state store connected to the server's /ws/mesh
 * endpoint. Maintains a local copy of all mesh state (agents, rooms,
 * messages, DMs) by applying state_sync and state_update patches received
 * over WebSocket. Exposes a postMessage API for the main thread to query
 * state, execute actions, and subscribe to real-time updates.
 *
 * Built as a separate IIFE bundle (mesh-worker.js) so the SharedWorker
 * runs in its own global scope independent of the main app bundle.
 */

// ---------------------------------------------------------------------------
// SharedWorker environment types (self-contained, no external imports)
// ---------------------------------------------------------------------------

interface SharedWorkerGlobalScope {
  addEventListener(
    type: "connect",
    listener: (event: MessageEvent) => void,
  ): void;
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

interface DeliveryEvent {
  type: string;
  [key: string]: unknown;
}

type MeshStatePatch =
  | { type: "agent_upsert"; agent: AgentIdentity }
  | { type: "agent_offline"; agentId: string }
  | { type: "room_upsert"; room: Room }
  | { type: "room_delete"; roomId: string }
  | { type: "message_add"; roomId: string; message: RoomMessage }
  | { type: "dm_add"; key: string; message: DmMessage }
  | { type: "delivery"; agentId: string; event: DeliveryEvent }
  | { type: "message_read"; messageId: string; readBy: string; room?: string };

interface SerialisedState {
  agents: Record<string, AgentIdentity>;
  rooms: Record<string, Room>;
  messages: Record<string, RoomMessage[]>;
  dms: Record<string, DmMessage[]>;
}

// ---------------------------------------------------------------------------
// Main-thread ↔ Worker message types
// ---------------------------------------------------------------------------

type WorkerInbound =
  | { type: "init"; url: string }
  | { type: "action"; id: string; action: Record<string, unknown> }
  | { type: "getState" };

interface StateSnapshot {
  agents: AgentIdentity[];
  rooms: Room[];
}

type WorkerOutbound =
  | { type: "state"; state: StateSnapshot }
  | { type: "patch"; patch: MeshStatePatch }
  | {
      type: "actionResult";
      id: string;
      result: { content: string; isError: boolean };
    }
  | { type: "actionError"; id: string; message: string }
  | { type: "connected" }
  | { type: "disconnected" };

// ---------------------------------------------------------------------------
// Lightweight mesh state
// ---------------------------------------------------------------------------

const agents = new Map<string, AgentIdentity>();
const rooms = new Map<string, Room>();
const messages = new Map<string, RoomMessage[]>();
const dms = new Map<string, DmMessage[]>();

function applyStateSync(state: SerialisedState): void {
  for (const [id, agent] of Object.entries(state.agents)) {
    agents.set(id, agent);
  }
  for (const [id, room] of Object.entries(state.rooms)) {
    rooms.set(id, room);
  }
  for (const [id, msgs] of Object.entries(state.messages)) {
    messages.set(id, msgs);
  }
  for (const [id, dmMsgs] of Object.entries(state.dms)) {
    dms.set(id, dmMsgs);
  }
}

function applyPatch(patch: MeshStatePatch): void {
  switch (patch.type) {
    case "agent_upsert": {
      const existing = agents.get(patch.agent.id);
      if (existing) {
        const merged = patch.agent;
        for (const r of existing.subscribedRooms) {
          if (!merged.subscribedRooms.includes(r)) {
            merged.subscribedRooms.push(r);
          }
        }
        agents.set(merged.id, merged);
      } else {
        agents.set(patch.agent.id, patch.agent);
      }
      break;
    }
    case "agent_offline": {
      const agent = agents.get(patch.agentId);
      if (agent) {
        agent.status = "offline";
        agents.set(patch.agentId, agent);
      }
      break;
    }
    case "room_upsert": {
      const existing = rooms.get(patch.room.id);
      if (existing) {
        const merged = patch.room;
        for (const m of existing.members) {
          if (!merged.members.includes(m)) merged.members.push(m);
        }
        rooms.set(merged.id, merged);
      } else {
        rooms.set(patch.room.id, patch.room);
      }
      break;
    }
    case "room_delete":
      rooms.delete(patch.roomId);
      break;
    case "message_add": {
      const arr = messages.get(patch.roomId) ?? [];
      arr.push(patch.message);
      messages.set(patch.roomId, arr);
      break;
    }
    case "dm_add": {
      const arr = dms.get(patch.key) ?? [];
      arr.push(patch.message);
      dms.set(patch.key, arr);
      break;
    }
    case "delivery":
      // Delivery events are forwarded to the main thread as patches.
      break;
    case "message_read": {
      if (patch.room) {
        const msgs = messages.get(patch.room);
        if (msgs) {
          const msg = msgs.find((m) => m.id === patch.messageId);
          if (msg && !msg.readBy.includes(patch.readBy)) {
            msg.readBy.push(patch.readBy);
          }
        }
      } else {
        for (const [, dmMsgs] of dms) {
          const msg = dmMsgs.find((m) => m.id === patch.messageId);
          if (msg && !msg.readBy.includes(patch.readBy)) {
            msg.readBy.push(patch.readBy);
          }
        }
      }
      break;
    }
  }
}

function getStateSnapshot(): StateSnapshot {
  return {
    agents: [...agents.values()],
    rooms: [...rooms.values()],
  };
}

// ---------------------------------------------------------------------------
// WebSocket connection to /ws/mesh
// ---------------------------------------------------------------------------

let ws: WebSocket | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let wsUrl: string | undefined;

function connect(url: string): void {
  wsUrl = url;
  if (reconnectTimer !== undefined) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }

  const socket = new WebSocket(url);
  ws = socket;

  socket.onopen = () => {
    broadcastToPorts({ type: "connected" });
  };

  socket.onclose = () => {
    ws = undefined;
    broadcastToPorts({ type: "disconnected" });
    scheduleReconnect();
  };

  socket.onerror = () => {
    // onclose fires after this
  };

  socket.onmessage = (event: MessageEvent) => {
    const raw: unknown = JSON.parse(
      typeof event.data === "string" ? event.data : String(event.data),
    );
    handleServerMessage(raw);
  };
}

function scheduleReconnect(): void {
  if (!wsUrl) return;
  reconnectTimer = setTimeout(() => {
    if (wsUrl) connect(wsUrl);
  }, 3000);
}

function handleServerMessage(raw: unknown): void {
  if (isMeshStateMessage(raw)) {
    if (raw.method === "state_sync") {
      applyStateSync(raw.state);
      broadcastToPorts({ type: "state", state: getStateSnapshot() });
    } else {
      applyPatch(raw.patch);
      broadcastToPorts({ type: "patch", patch: raw.patch });
    }
    return;
  }

  // Action responses from the server — { type: "result" } or { type: "error" }
  if (typeof raw === "object" && raw !== null && "type" in raw) {
    if (
      raw.type === "result" &&
      "result" in raw &&
      typeof raw.result === "object" &&
      raw.result !== null &&
      "content" in raw.result &&
      typeof raw.result.content === "string" &&
      "isError" in raw.result &&
      typeof raw.result.isError === "boolean"
    ) {
      broadcastToPorts({
        type: "actionResult",
        id: "",
        result: { content: raw.result.content, isError: raw.result.isError },
      });
    } else if (
      raw.type === "error" &&
      "message" in raw &&
      typeof raw.message === "string"
    ) {
      broadcastToPorts({
        type: "actionError",
        id: "",
        message: raw.message,
      });
    }
  }
}

function isMeshStateMessage(
  value: unknown,
): value is
  | { method: "state_sync"; state: SerialisedState }
  | { method: "state_update"; patch: MeshStatePatch } {
  if (typeof value !== "object" || value === null) return false;
  if (!("method" in value)) return false;
  const method = value.method;
  return (
    typeof method === "string" &&
    (method === "state_sync" || method === "state_update")
  );
}

// ---------------------------------------------------------------------------
// Port management — fan-out to all connected main-thread tabs
// ---------------------------------------------------------------------------

const ports = new Set<MessagePortLike>();

function broadcastToPorts(msg: WorkerOutbound): void {
  const data = JSON.stringify(msg);
  for (const port of ports) {
    try {
      port.postMessage(data);
    } catch {
      // Port closed — cleaned up via port.onmessage error
    }
  }
}

function handlePortMessage(msg: WorkerInbound): void {
  switch (msg.type) {
    case "init":
      connect(msg.url);
      break;
    case "action": {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg.action));
      }
      break;
    }
    case "getState":
      broadcastToPorts({ type: "state", state: getStateSnapshot() });
      break;
  }
}

function isWorkerInbound(value: unknown): value is WorkerInbound {
  if (typeof value !== "object" || value === null) return false;
  if (!("type" in value)) return false;
  const t = value.type;
  return (
    typeof t === "string" &&
    (t === "init" || t === "action" || t === "getState")
  );
}

// ---------------------------------------------------------------------------
// Entry point — listen for SharedWorker connections
// ---------------------------------------------------------------------------

self.addEventListener("connect", (event: MessageEvent) => {
  const rawPort = event.ports[0];
  if (rawPort === undefined) return;
  // MessagePort satisfies MessagePortLike (has postMessage, close, onmessage)
  ports.add(rawPort);

  // Send current state to the new port
  try {
    rawPort.postMessage(
      JSON.stringify({
        type: "state",
        state: getStateSnapshot(),
      } satisfies WorkerOutbound),
    );
  } catch {
    // Port not ready yet — will get state on next update
  }

  rawPort.onmessage = (e: MessageEvent) => {
    const parsed: unknown = JSON.parse(
      typeof e.data === "string" ? e.data : String(e.data),
    );
    if (isWorkerInbound(parsed)) {
      handlePortMessage(parsed);
    }
  };
});

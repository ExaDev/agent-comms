/**
 * SharedWorker — browser mesh node.
 *
 * Runs a lightweight mesh state store connected to the server's oRPC mesh endpoint. Maintains a local copy of all mesh state (agents, rooms, messages, DMs) by applying state_sync and state_patch events from the unified subscribeEvents stream. Exposes a postMessage API for the main thread to query state, execute actions, and subscribe to real-time updates -- that tab-facing postMessage protocol is unchanged by the oRPC migration; only how the worker itself talks upstream changed.
 *
 * Built as a separate IIFE bundle (mesh-worker.js) so the SharedWorker runs in its own global scope independent of the main app bundle.
 */

import { createORPCClient, getEventMeta } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import { RetryLinkPlugin } from "@orpc/client/plugins";
import type { ContractRouterClient } from "@orpc/contract";
import type { MeshContract } from "../contract.js";

// ---------------------------------------------------------------------------
// SharedWorker environment types
// ---------------------------------------------------------------------------

interface SharedWorkerGlobalScope {
  addEventListener: (
    type: "connect",
    listener: (event: MessageEvent) => void,
  ) => void;
  close: () => void;
}

interface MessagePortLike {
  postMessage: (message: unknown) => void;
  close: () => void;
  onmessage: ((event: MessageEvent) => void) | null;
}

declare const self: SharedWorkerGlobalScope;

// ---------------------------------------------------------------------------
// Wire protocol types (inlined — mirrors core/wire-protocol.ts)
// ---------------------------------------------------------------------------

export interface AgentIdentity {
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

export interface Room {
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
  replyTo?: string | undefined;
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

export const agents = new Map<string, AgentIdentity>();
export const rooms = new Map<string, Room>();
export const messages = new Map<string, RoomMessage[]>();
export const dms = new Map<string, DmMessage[]>();

export function applyStateSync(state: SerialisedState): void {
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

/**
 * Applies one server-sent patch to local state. Never merges with the existing local copy -- the worker holds a single WebSocket connection to exactly one server, and the server has already computed the fully-merged, authoritative record (delivery-engine.ts's own version-gated CRDT merge) before ever broadcasting it, so whatever a patch carries IS the correct state, full stop. Merging on top of a possibly-stale local copy (the previous behaviour) can only make things worse -- e.g. resurrecting a room or member the server already removed, since the worker has no version field to know its own copy might already be the older one.
 */
export function applyPatch(patch: MeshStatePatch): void {
  switch (patch.type) {
    case "agent_upsert":
      agents.set(patch.agent.id, patch.agent);
      break;
    case "agent_offline": {
      const agent = agents.get(patch.agentId);
      if (agent) {
        agent.status = "offline";
        agents.set(patch.agentId, agent);
      }
      break;
    }
    case "room_upsert":
      rooms.set(patch.room.id, patch.room);
      break;
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
      if (patch.room !== undefined) {
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

export function getStateSnapshot(): StateSnapshot {
  return {
    agents: [...agents.values()],
    rooms: [...rooms.values()],
  };
}

// ---------------------------------------------------------------------------
// oRPC client connection to /ws/mesh-orpc -- the worker's upstream half.
//
// mesh-client.ts (unchanged until a later PR) still sends an "init" message carrying a URL built for the legacy /ws/mesh path; toOrpcUrl rewrites it to the temporary oRPC path (added server-side, dark-launched, in the PR preceding this one) so the worker's own tab-facing contract with mesh-client.ts stays identical while its real upstream traffic moves onto oRPC. Reconnection is RPCLink's own `reconnect` option; resuming a subscribeEvents stream across a reconnect specifically needs RetryLinkPlugin as well -- WebSocketLinkTransport's reconnect only re-establishes the raw socket, it does not itself resume an in-flight event-iterator by lastEventId (confirmed against the installed beta's own source, not assumed from either option's name).
// ---------------------------------------------------------------------------

type MeshOrpcClient = ContractRouterClient<MeshContract>;

let orpcClient: MeshOrpcClient | undefined;
let eventPumpGeneration = 0;

function toOrpcUrl(legacyMeshUrl: string): string {
  return legacyMeshUrl.replace(/\/ws\/mesh$/, "/ws/mesh-orpc");
}

/** Base delay for the reconnect backoff, doubled per attempt and capped at RECONNECT_MAX_DELAY_MS. */
const RECONNECT_BASE_DELAY_MS = 1000;
/** Upper bound on the reconnect backoff delay. */
const RECONNECT_MAX_DELAY_MS = 30_000;

export function connect(url: string): void {
  const orpcUrl = toOrpcUrl(url);

  const link = new RPCLink({
    connect: async () => {
      const socket = new WebSocket(orpcUrl);
      socket.addEventListener("open", () => {
        broadcastToPorts({ type: "connected" });
      });
      socket.addEventListener("close", () => {
        broadcastToPorts({ type: "disconnected" });
      });
      return new Promise<WebSocket>((resolve, reject) => {
        socket.addEventListener(
          "open",
          () => {
            resolve(socket);
          },
          { once: true },
        );
        socket.addEventListener("error", reject, { once: true });
      });
    },
    reconnect: {
      enabled: true,
      delay: (info) =>
        Math.min(
          RECONNECT_BASE_DELAY_MS * 2 ** info.attempt,
          RECONNECT_MAX_DELAY_MS,
        ),
    },
    plugins: [new RetryLinkPlugin()],
  });

  const client: MeshOrpcClient = createORPCClient(link);
  orpcClient = client;
  void pumpEvents(client, ++eventPumpGeneration);
}

/**
 * Consumes the unified event stream for as long as this generation is current -- eventPumpGeneration lets a fresh connect() call (a new "init" message) abandon a stale pump loop instead of running two concurrently against the same worker state.
 *
 * Confirmed empirically (a real server-side socket termination, not assumed from either option's name): RetryLinkPlugin does NOT transparently resume an already-active subscribeEvents() call across a transport-level drop -- the in-flight for-await throws (an AbortError from the closed socket) instead of pausing and resuming underneath the same iterator. The outer while loop here is what actually implements resume-after-reconnect: on any thrown error it loops back and calls subscribeEvents again with lastEventId, which naturally blocks until RPCLink's own reconnect option re-establishes the underlying socket, then resumes exactly where the stream left off.
 */
async function pumpEvents(
  client: Readonly<MeshOrpcClient>,
  generation: number,
): Promise<void> {
  let lastEventId: string | undefined;

  while (generation === eventPumpGeneration) {
    try {
      const events = await client.subscribeEvents(
        lastEventId === undefined ? {} : { lastEventId },
      );
      for await (const event of events) {
        if (generation !== eventPumpGeneration) return;
        const meta = getEventMeta(event);
        if (meta?.id !== undefined) lastEventId = meta.id;
        switch (event.kind) {
          case "state_sync":
            applyStateSync(event.state);
            broadcastToPorts({ type: "state", state: getStateSnapshot() });
            break;
          case "state_patch":
            applyPatch(event.patch);
            broadcastToPorts({ type: "patch", patch: event.patch });
            break;
          case "delivery":
            // Not yet part of the worker's tab-facing protocol -- delivery events still flow to tabs over the separate legacy chat socket (main.tsx's CommsWs) until that cutover lands.
            break;
        }
      }
      // The server ended the stream normally -- nothing left to resume.
      return;
    } catch {
      // Transport dropped mid-stream. Loop back and resume from lastEventId once subscribeEvents() can succeed again.
    }
  }
}

async function dispatchAction(
  client: Readonly<MeshOrpcClient>,
  action: Record<string, unknown>,
): Promise<{ content: string; isError: boolean }> {
  const str = (key: string): string => {
    const value = action[key];
    return typeof value === "string" ? value : "";
  };
  const optStr = (key: string): string | undefined => {
    const value = action[key];
    return typeof value === "string" ? value : undefined;
  };
  const roomType = (): "public" | "private" | "secret" => {
    const value = action.type;
    return value === "public" || value === "private" || value === "secret"
      ? value
      : "public";
  };

  switch (action.action) {
    case "send":
      return client.send({ target: str("target"), content: str("content") });
    case "dm":
      return client.dm({ target: str("target"), content: str("content") });
    case "join_room":
      return client.joinRoom({ room: str("room") });
    case "leave_room":
      return client.leaveRoom({ room: optStr("room") });
    case "create_room":
      return client.createRoom({
        name: str("name"),
        type: roomType(),
        description: optStr("description"),
      });
    case "list_rooms":
      return client.listRooms({});
    case "list_agents":
      return client.listAgents({});
    case "read_room":
      return client.readRoom({ room: optStr("room") });
    case "destroy_room":
      return client.destroyRoom({ room: str("room") });
    case "invite":
      return client.invite({ room: str("room"), agent: str("agent") });
    case "decline_invite":
      return client.declineInvite({
        room: str("room"),
        reason: str("reason"),
      });
    case "kick":
      return client.kick({ room: str("room"), agent: str("agent") });
    case "rename_agent":
      return client.renameAgent({ agent: str("agent"), name: str("name") });
    default:
      return {
        content: `Unknown action: ${String(action.action)}`,
        isError: true,
      };
  }
}

// ---------------------------------------------------------------------------
// Port management — fan-out to all connected main-thread tabs
// ---------------------------------------------------------------------------

export const ports = new Set<MessagePortLike>();

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
      const client = orpcClient;
      if (!client) break;
      const id = msg.id;
      dispatchAction(client, msg.action)
        .then((result) => {
          broadcastToPorts({ type: "actionResult", id, result });
        })
        .catch((err: unknown) => {
          broadcastToPorts({
            type: "actionError",
            id,
            message: err instanceof Error ? err.message : String(err),
          });
        });
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

/** Registers the real SharedWorker entry point. Guarded on `self` actually existing as a SharedWorkerGlobalScope: this module is imported directly (not just bundled) by unit tests exercising the pure reducer functions above, and a plain Node test environment has no global `self` at all. */
if (typeof self !== "undefined") {
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
}

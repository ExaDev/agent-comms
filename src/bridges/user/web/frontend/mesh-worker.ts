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
import { implement } from "@orpc/server";
import { RPCHandler } from "@orpc/server/message-port";
import type { ContractRouterClient } from "@orpc/contract";
import type { MeshContract } from "../contract.js";
import { MeshEventPublisher } from "../event-publisher.js";
import { tabContract } from "./tab-contract.js";
import { dispatchAction } from "./dispatch-action.js";
import type {
  AgentIdentity as CoreAgentIdentity,
  Room as CoreRoom,
  RoomMessage as CoreRoomMessage,
  DmMessage as CoreDmMessage,
} from "../../../../core/types.js";

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
// Wire protocol types -- aliases onto core/types.ts's real, single-source-of-truth entity types (type-only imports, so nothing from core's Zod schemas is actually bundled into the worker; these names existed as hand-written, narrower local interfaces before the oRPC migration, but this file's own tab-facing subscribeEvents (below) needs the real shape -- including version/memberJoins/etc -- back to construct a contract-conformant state_sync, and duplicating a third, narrower copy just to avoid that is exactly the kind of drift PR1 of this migration already found and fixed once (frontend/types.ts's own DeliveryEvent union, mesh-worker.ts's own former MeshStatePatch carrying a dead "message_read" variant).
// ---------------------------------------------------------------------------

export type AgentIdentity = CoreAgentIdentity;
export type Room = CoreRoom;
type RoomMessage = CoreRoomMessage;
type DmMessage = CoreDmMessage;

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

/** Republishes every event this worker receives from the real server to any tab subscribed via the worker's own oRPC downstream (tab-contract.ts's subscribeEvents). Resumable the same way the server's own publisher is -- a tab's oRPC client can reconnect to this worker (a new MessagePort, or the same one after a drop) and resume from its own lastEventId. */
export const localPublisher = new MeshEventPublisher();

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
      // attempt === 1 is the very first connection, never a retry -- oRPC's own documented default for this option (`info => info.attempt === 1 ? 0 : 2_000`) special-cases it to 0 for exactly this reason. Missing that case here meant every single connection, including the first, waited out a real ~2s delay before ever attempting to connect -- confirmed directly: e2e specs that create a room or send a message went from ~300ms to ~2.6s each once this landed, and dropped straight back down once fixed.
      delay: (info) =>
        info.attempt === 1
          ? 0
          : Math.min(
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
        // Republish to the worker's own downstream (tab-contract.ts's subscribeEvents) with a fresh, worker-assigned id -- a separate resumability domain from the server's own, since a tab resumes against this worker, not against the server directly.
        localPublisher.publish(event);
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
            // Not part of the legacy postMessage protocol's own WorkerOutbound union -- delivery events reach tabs exclusively through the oRPC tab-contract.ts subscribeEvents stream, via localPublisher.publish(event) above (applied uniformly to every event kind, not just this one).
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
// Tab-facing oRPC downstream -- the worker as a server. Dark: nothing in mesh-client.ts connects via oRPC to this yet (that's a later PR's cutover), but it's fully wired and independently testable via a real MessagePort pair, side by side with the legacy postMessage protocol above, which stays completely untouched on the same port.
// ---------------------------------------------------------------------------

interface TabRouterContext {
  port: MessagePort;
}

/** The worker's own merged state, in the same SerialisedState shape the server's state_sync carries -- built from all four local Maps, not just the narrower "agents, rooms" StateSnapshot broadcastToPorts uses for the legacy protocol. */
function buildSerialisedState(): SerialisedState {
  return {
    agents: Object.fromEntries(agents),
    rooms: Object.fromEntries(rooms),
    messages: Object.fromEntries(messages),
    dms: Object.fromEntries(dms),
  };
}

async function upstream(
  input: Record<string, unknown>,
): Promise<{ content: string; isError: boolean }> {
  if (!orpcClient) {
    return { content: "Not connected to mesh yet", isError: true };
  }
  return dispatchAction(orpcClient, input);
}

const tabImpl = implement(tabContract).$context<TabRouterContext>();

// Declared ahead of tabRouter (its .current assigned after it, below) so disconnect's own handler -- itself a value inside tabRouter -- can close over this ref; the closure only reads it once a real call arrives, well after the assignment below has run.
const tabRpcHandlerRef: { current?: RPCHandler<TabRouterContext> } = {};

const tabRouter = {
  send: tabImpl.send.handler(async ({ input }) =>
    upstream({ action: "send", ...input }),
  ),
  dm: tabImpl.dm.handler(async ({ input }) =>
    upstream({ action: "dm", ...input }),
  ),
  joinRoom: tabImpl.joinRoom.handler(async ({ input }) =>
    upstream({ action: "join_room", room: input.room }),
  ),
  leaveRoom: tabImpl.leaveRoom.handler(async ({ input }) =>
    upstream({ action: "leave_room", room: input.room }),
  ),
  createRoom: tabImpl.createRoom.handler(async ({ input }) =>
    upstream({
      action: "create_room",
      name: input.name,
      type: input.type,
      description: input.description,
    }),
  ),
  listRooms: tabImpl.listRooms.handler(async () =>
    upstream({ action: "list_rooms" }),
  ),
  listAgents: tabImpl.listAgents.handler(async () =>
    upstream({ action: "list_agents" }),
  ),
  readRoom: tabImpl.readRoom.handler(async ({ input }) =>
    upstream({ action: "read_room", room: input.room }),
  ),
  destroyRoom: tabImpl.destroyRoom.handler(async ({ input }) =>
    upstream({ action: "destroy_room", room: input.room }),
  ),
  invite: tabImpl.invite.handler(async ({ input }) =>
    upstream({ action: "invite", room: input.room, agent: input.agent }),
  ),
  declineInvite: tabImpl.declineInvite.handler(async ({ input }) =>
    upstream({
      action: "decline_invite",
      room: input.room,
      reason: input.reason,
    }),
  ),
  kick: tabImpl.kick.handler(async ({ input }) =>
    upstream({ action: "kick", room: input.room, agent: input.agent }),
  ),
  renameAgent: tabImpl.renameAgent.handler(async ({ input }) =>
    upstream({ action: "rename_agent", agent: input.agent, name: input.name }),
  ),
  pushSubscribe: tabImpl.pushSubscribe.handler(async ({ input }) =>
    upstream({
      action: "push_subscribe",
      subscription: input.subscription,
      agentId: input.agentId,
    }),
  ),
  pushUnsubscribe: tabImpl.pushUnsubscribe.handler(async ({ input }) =>
    upstream({ action: "push_unsubscribe", agentId: input.agentId }),
  ),

  subscribeEvents: tabImpl.subscribeEvents.handler(async function* ({
    input,
    signal,
  }) {
    if (input.lastEventId === undefined) {
      yield { kind: "state_sync" as const, state: buildSerialisedState() };
    }
    yield* localPublisher.subscribe({
      ...(signal ? { signal } : {}),
      ...(input.lastEventId !== undefined
        ? { lastEventId: input.lastEventId }
        : {}),
    });
  }),

  disconnect: tabImpl.disconnect.handler(async ({ context }) => {
    // Closing the peer synchronously, before this handler returns, tears down the same port the RPC response itself still needs to go out over -- confirmed empirically (a real hang, not assumed): awaiting close() here means the client's disconnect() call never resolves at all. A microtask defer wasn't enough separation either (still hung) -- a macrotask (setTimeout) is what actually lets the response finish being posted before the port closes.
    setTimeout(() => {
      void tabRpcHandlerRef.current?.close(context.port);
    }, 0);
    return {};
  }),
};

tabRpcHandlerRef.current = new RPCHandler(tabRouter);

// ---------------------------------------------------------------------------
// Entry point — listen for SharedWorker connections
// ---------------------------------------------------------------------------

/**
 * Wires the new oRPC tab-contract.ts downstream onto a port -- dark, nothing in mesh-client.ts speaks it yet, but it's real and independently reachable. Exported (read-only: never assigns any of the port's own properties, unlike the legacy protocol's onmessage wiring below) so a test can drive it directly against a real MessagePort pair without simulating a real SharedWorker "connect" event.
 */
export function upgradeTabRpcPort(port: Readonly<MessagePort>): void {
  tabRpcHandlerRef.current?.upgrade(port, { context: { port } });
}

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

    // The new oRPC downstream, dark: wired via addEventListener (confirmed against the installed adapter's own source, not assumed), which coexists safely alongside the legacy onmessage assignment above on the same port -- both fire independently, and each side's own message-shape check ignores frames meant for the other.
    upgradeTabRpcPort(rawPort);
  });
}

/**
 * oRPC contract for the web UI's browser-to-server protocol.
 *
 * One procedure per browser-facing action, plus a single `subscribeEvents` procedure that unifies what the JSON-over-WebSocket protocol split across three separate concepts: the chat socket's `delivery` frames, the mesh socket's `state_sync` method, and its `state_update` method. Entity and delivery-event shapes are imported from core/types.ts rather than re-declared here -- core already carries the single source of truth Zod schema for each (AgentIdentitySchema, RoomSchema, RoomMessageSchema, DmMessageSchema, DeliveryEventSchema), and duplicating them a third time (frontend/types.ts's hand-written interfaces are the second copy) is exactly the kind of drift that let frontend/mesh-worker.ts's local MeshStatePatch keep a "message_read" variant the real server stopped emitting once room.read replaced the old mesh-wide broadcast.
 */

import { z } from "zod";
import { oc, eventIterator } from "@orpc/contract";
import {
  AgentIdentitySchema,
  RoomSchema,
  RoomMessageSchema,
  DmMessageSchema,
  DeliveryEventSchema,
} from "../../../core/types.js";

// ---------------------------------------------------------------------------
// Shared fragments
// ---------------------------------------------------------------------------

const ActionResultSchema = z.object({
  content: z.string(),
  isError: z.boolean(),
});

const RoomTypeSchema = z.union([
  z.literal("public"),
  z.literal("private"),
  z.literal("secret"),
]);

// ---------------------------------------------------------------------------
// Mesh graph and path trace -- mirrors core/transport.ts's MeshGraph/MeshTraceResult shape, the same "mirror, don't import" precedent as MeshStatePatchSchema above (core's own interfaces aren't Zod-backed, and don't need to be for their many non-browser callers). MeshTraceResult.outcome is wire-mesh-core's own ManageOutcome, an external union this contract has no reason to model in full -- only the two fields the UI actually reads (result, code) are validated; everything else on the outcome object passes through unchecked.
// ---------------------------------------------------------------------------

const MeshGraphEdgeSchema = z.object({
  kind: z.union([z.literal("direct"), z.literal("relay")]),
  from: z.string(),
  to: z.string(),
  via: z.string().optional(),
});

const MeshGraphSchema = z.object({
  nodes: z.array(z.string()),
  edges: z.array(MeshGraphEdgeSchema),
});

const MeshTraceSideSchema = z.object({
  relayed: z.boolean(),
  hubAddress: z.string().optional(),
});

const MeshTraceResultSchema = z.object({
  rttMs: z.number(),
  local: MeshTraceSideSchema,
  remote: MeshTraceSideSchema.optional(),
  outcome: z
    .object({ result: z.string(), code: z.string().optional() })
    .loose(),
});

// ---------------------------------------------------------------------------
// Mesh state patch -- mirrors core/wire-protocol.ts's MeshStatePatch exactly (7 variants; no "message_read", which room.read/P3.5 already replaced).
// ---------------------------------------------------------------------------

const MeshStatePatchSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent_upsert"), agent: AgentIdentitySchema }),
  z.object({ type: z.literal("agent_offline"), agentId: z.string() }),
  z.object({ type: z.literal("room_upsert"), room: RoomSchema }),
  z.object({ type: z.literal("room_delete"), roomId: z.string() }),
  z.object({
    type: z.literal("message_add"),
    roomId: z.string(),
    message: RoomMessageSchema,
  }),
  z.object({
    type: z.literal("dm_add"),
    key: z.string(),
    message: DmMessageSchema,
  }),
  z.object({
    type: z.literal("delivery"),
    agentId: z.string(),
    event: DeliveryEventSchema,
  }),
]);

const SerialisedStateSchema = z.object({
  agents: z.record(z.string(), AgentIdentitySchema),
  rooms: z.record(z.string(), RoomSchema),
  messages: z.record(z.string(), z.array(RoomMessageSchema)),
  dms: z.record(z.string(), z.array(DmMessageSchema)),
});

/**
 * The one stream every tab subscribes to. Unifies state_sync (a full snapshot, sent once on connect or resume-without-lastEventId), state_update (an incremental patch), and the old chat socket's delivery frames -- today three separate wire concepts -- into a single ordered event stream a tab can resume by lastEventId.
 */
const MeshEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("state_sync"), state: SerialisedStateSchema }),
  z.object({ kind: z.literal("state_patch"), patch: MeshStatePatchSchema }),
  z.object({ kind: z.literal("delivery"), event: DeliveryEventSchema }),
]);

// ---------------------------------------------------------------------------
// Push subscription (PWA)
// ---------------------------------------------------------------------------

const PushSubscriptionSchema = z.object({
  endpoint: z.string(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
});

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export const meshContract = {
  send: oc
    .input(z.object({ target: z.string(), content: z.string() }))
    .output(ActionResultSchema),

  dm: oc
    .input(z.object({ target: z.string(), content: z.string() }))
    .output(ActionResultSchema),

  joinRoom: oc.input(z.object({ room: z.string() })).output(ActionResultSchema),

  leaveRoom: oc
    .input(z.object({ room: z.string().optional() }))
    .output(ActionResultSchema),

  createRoom: oc
    .input(
      z.object({
        name: z.string(),
        type: RoomTypeSchema,
        description: z.string().optional(),
      }),
    )
    .output(ActionResultSchema),

  listRooms: oc.input(z.object({})).output(ActionResultSchema),

  listAgents: oc.input(z.object({})).output(ActionResultSchema),

  readRoom: oc
    .input(z.object({ room: z.string().optional() }))
    .output(ActionResultSchema),

  destroyRoom: oc
    .input(z.object({ room: z.string() }))
    .output(ActionResultSchema),

  invite: oc
    .input(z.object({ room: z.string(), agent: z.string() }))
    .output(ActionResultSchema),

  declineInvite: oc
    .input(z.object({ room: z.string(), reason: z.string() }))
    .output(ActionResultSchema),

  kick: oc
    .input(z.object({ room: z.string(), agent: z.string() }))
    .output(ActionResultSchema),

  renameAgent: oc
    .input(z.object({ agent: z.string(), name: z.string() }))
    .output(ActionResultSchema),

  pushSubscribe: oc
    .input(
      z.object({
        subscription: PushSubscriptionSchema,
        agentId: z.string().optional(),
      }),
    )
    .output(ActionResultSchema),

  pushUnsubscribe: oc
    .input(z.object({ agentId: z.string().optional() }))
    .output(ActionResultSchema),

  subscribeEvents: oc
    .input(z.object({ lastEventId: z.string().optional() }))
    .output(eventIterator(MeshEventSchema)),

  // -------------------------------------------------------------------------
  // Structured one-shot reads (agent-comms#206) -- genuinely request/response data with no real-time channel of its own, unlike agents/rooms (already fully covered by subscribeEvents' state_sync/state_patch above, so deliberately not duplicated here as a read procedure). Distinct from listRooms/listAgents/readRoom above, which are the legacy CLI-text-command equivalents (ActionResult output, for chat-style /list and /read commands) -- these return real structured JSON, the same shape the REST endpoints they share an implementation with already return.
  // -------------------------------------------------------------------------

  getRoomMessages: oc
    .input(z.object({ room: z.string(), since: z.string().optional() }))
    .output(z.array(RoomMessageSchema)),

  getMeshGraph: oc.input(z.object({})).output(MeshGraphSchema),

  getMeshTrace: oc
    .input(z.object({ target: z.string(), timeoutMs: z.number().optional() }))
    .output(MeshTraceResultSchema),
};

export type MeshEvent = z.infer<typeof MeshEventSchema>;
export type MeshStatePatch = z.infer<typeof MeshStatePatchSchema>;
export type SerialisedState = z.infer<typeof SerialisedStateSchema>;
export type ActionResult = z.infer<typeof ActionResultSchema>;
export type MeshGraph = z.infer<typeof MeshGraphSchema>;
export type MeshTraceResult = z.infer<typeof MeshTraceResultSchema>;

/** Type-only handle onto the contract's shape for building a typed client (`ContractRouterClient<MeshContract>`) without importing the contract's own runtime value -- browser code that only needs the type (mesh-worker.ts, mesh-client.ts) can `import type` this and never bundle Zod/core's schemas at all, since a type-only import is erased entirely at build time. */
export type MeshContract = typeof meshContract;

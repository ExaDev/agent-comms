/**
 * Agent Comms — shared protocol types and Zod schemas.
 *
 * Every type is derived from its Zod schema (single source of truth).
 * Use `Schema.parse(raw)` at JSON boundaries instead of `JSON.parse(raw) as T`.
 * Use `Schema.is(value)` for type narrowing.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema-attached type guard helper
// ---------------------------------------------------------------------------

/** Narrows `value` to a schema already carrying an `is` guard -- used only to recover the type Object.defineProperty's own signature can't express, immediately after defineSchema has just added that exact property below. */
function hasIsGuard<T extends z.ZodType>(
  value: T,
): value is T & { is: (v: unknown) => v is z.infer<T> } {
  if (!("is" in value)) return false;
  return typeof value.is === "function";
}

/** Attaches a type-guard `.is` method directly onto the given schema (mutating it in place, never copying it) and returns that same reference. Mutation in place is load-bearing: Zod v4 schemas carry their `.parse`/`.safeParse`/internal brand as own instance properties rather than prototype methods, so spreading into a fresh object (`{ ...schema, is }`) silently strips the brand `z.object()` checks for when this schema is nested as another schema's property value -- confirmed directly: a spread-built schema is rejected with "expected a Zod schema" the moment it's used as a nested property. */
function defineSchema<T extends z.ZodType>(
  schema: T,
): T & { is: (value: unknown) => value is z.infer<T> } {
  Object.defineProperty(schema, "is", {
    value: (value: unknown): value is z.infer<T> =>
      schema.safeParse(value).success,
    enumerable: true,
  });
  if (!hasIsGuard(schema)) {
    throw new Error("unreachable: is was just defined above");
  }
  return schema;
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

// Agent and Room IDs are plain strings internally.
// Branded types removed — they caused unused-var warnings since
// Zod brand schemas are never referenced as values.
export type AgentId = string;
export type RoomId = string;

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

// Each enum's schema is declared under a `Schema` suffix and re-exported under its bare name (matching this file's own object-schema convention) rather than sharing one identifier between the const and the inferred type -- @typescript-eslint/no-redeclare's `ignoreDeclarationMerge` allowlist covers interface/namespace/class/function/enum merges but not a value binding and a type alias sharing a name, so the two need genuinely distinct local identifiers. The re-export alias keeps the public name (and therefore every existing `import { X }` / `import type { X }` call site across the codebase) completely unchanged.
const MeshVisibilitySchema = defineSchema(
  z.union([z.literal("discoverable"), z.literal("quiet"), z.literal("dark")]),
);
export type MeshVisibility = z.infer<typeof MeshVisibilitySchema>;
export { MeshVisibilitySchema as MeshVisibility };

const VisibilitySchema = defineSchema(
  z.union([z.literal("visible"), z.literal("hidden"), z.literal("ghost")]),
);
export type Visibility = z.infer<typeof VisibilitySchema>;
export { VisibilitySchema as Visibility };

const AgentStatusSchema = defineSchema(
  z.union([
    z.literal("active"),
    z.literal("idle"),
    z.literal("busy"),
    z.literal("offline"),
  ]),
);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;
export { AgentStatusSchema as AgentStatus };

const RoomTypeSchema = defineSchema(
  z.union([z.literal("public"), z.literal("private"), z.literal("secret")]),
);
export type RoomType = z.infer<typeof RoomTypeSchema>;
export { RoomTypeSchema as RoomType };

const StreamingBehaviorSchema = defineSchema(
  z.union([z.literal("steer"), z.literal("followUp"), z.literal("info")]),
);
export type StreamingBehavior = z.infer<typeof StreamingBehaviorSchema>;
export { StreamingBehaviorSchema as StreamingBehavior };

// ---------------------------------------------------------------------------
// AgentIdentity
// ---------------------------------------------------------------------------

export const AgentIdentitySchema = defineSchema(
  z.object({
    id: z.string(),
    /** Monotonic revision, bumped by the mutating store; sync merges take the higher value. */
    version: z.number(),
    name: z.string(),
    harness: z.string(),
    cwd: z.string(),
    pid: z.number(),
    startedAt: z.string(),
    visibility: VisibilitySchema,
    status: AgentStatusSchema,
    tags: z.array(z.string()),
    subscribedRooms: z.array(z.string()),
  }),
);
export type AgentIdentity = z.infer<typeof AgentIdentitySchema>;

// ---------------------------------------------------------------------------
// Room
// ---------------------------------------------------------------------------

export const RoomSchema = defineSchema(
  z.object({
    id: z.string(),
    /** Monotonic revision, bumped by the mutating store; sync merges take the higher value. */
    version: z.number(),
    name: z.string(),
    type: RoomTypeSchema,
    owner: z.string(),
    createdAt: z.string(),
    description: z.string(),
    members: z.array(z.string()),
    invited: z.array(z.string()),
    /**
     * Per-agent membership operations for convergent merges. An agent is a
     * member (or invited) iff their latest join's room revision strictly
     * exceeds their latest leave's, so a leave at the same revision wins:
     * concurrent kicks and joins converge with the kick honoured, while
     * joins of different agents never interact. `members` and `invited` are
     * derived views, refreshed after every mutation and merge.
     */
    memberJoins: z.record(z.string(), z.number()),
    memberLeaves: z.record(z.string(), z.number()),
    invitedJoins: z.record(z.string(), z.number()),
    invitedLeaves: z.record(z.string(), z.number()),
  }),
);
export type Room = z.infer<typeof RoomSchema>;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export const RoomMessageSchema = defineSchema(
  z.object({
    id: z.string(),
    from: z.string(),
    room: z.string(),
    content: z.string(),
    timestamp: z.string(),
    replyTo: z.string().optional(),
    readBy: z.array(z.string()),
    streamingBehavior: StreamingBehaviorSchema.optional(),
  }),
);
export type RoomMessage = z.infer<typeof RoomMessageSchema>;

export const DmMessageSchema = defineSchema(
  z.object({
    id: z.string(),
    from: z.string(),
    to: z.string(),
    content: z.string(),
    timestamp: z.string(),
    readBy: z.array(z.string()),
    streamingBehavior: StreamingBehaviorSchema.optional(),
  }),
);
export type DmMessage = z.infer<typeof DmMessageSchema>;

const DeliveryStatusSchema = defineSchema(
  z.union([z.literal("delivered"), z.literal("read")]),
);
export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>;
export { DeliveryStatusSchema as DeliveryStatus };

// ---------------------------------------------------------------------------
// Delivery events
// ---------------------------------------------------------------------------

export const RoomMemberSchema = defineSchema(
  z.object({
    id: z.string(),
    name: z.string(),
    status: AgentStatusSchema,
  }),
);
export type RoomMember = z.infer<typeof RoomMemberSchema>;

export const DeliveryEventSchema = defineSchema(
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("room_message"),
      message: RoomMessageSchema,
    }),
    z.object({
      type: z.literal("dm"),
      message: DmMessageSchema,
    }),
    z.object({
      type: z.literal("room_invite"),
      room: z.string(),
      roomDescription: z.string(),
      from: z.string(),
      fromName: z.string(),
      fromCwd: z.string(),
    }),
    z.object({
      type: z.literal("member_joined"),
      room: z.string(),
      agent: z.string(),
    }),
    z.object({
      type: z.literal("member_left"),
      room: z.string(),
      agent: z.string(),
    }),
    z.object({
      type: z.literal("room_members"),
      room: z.string(),
      members: z.array(RoomMemberSchema),
    }),
    z.object({
      type: z.literal("member_status"),
      room: z.string(),
      agent: z.string(),
      status: AgentStatusSchema,
    }),
    z.object({
      type: z.literal("delivery_status"),
      messageId: z.string(),
      agent: z.string(),
      status: DeliveryStatusSchema,
      room: z.string().optional(),
    }),
    z.object({
      type: z.literal("invite_declined"),
      room: z.string(),
      agent: z.string(),
      agentName: z.string(),
      reason: z.string(),
    }),
    z.object({
      type: z.literal("name_changed"),
      agent: z.string(),
      oldName: z.string(),
      newName: z.string(),
    }),
    z.object({
      type: z.literal("connection_request"),
      connectionId: z.string(),
      peerId: z.string(),
      dataPort: z.number(),
      name: z.string(),
      fingerprint: z.string(),
    }),
    z.object({
      type: z.literal("capability_request"),
      requestId: z.string(),
      capability: z.string(),
      scopeKind: z.string(),
      scopePath: z.string().optional(),
      requesterDevice: z.string(),
    }),
  ]),
);
export type DeliveryEvent = z.infer<typeof DeliveryEventSchema>;

// ---------------------------------------------------------------------------
// Network interfaces
// ---------------------------------------------------------------------------

export interface NetworkInterface {
  name: string;
  address: string;
  family: "IPv4" | "IPv6";
  internal: boolean;
}

// ---------------------------------------------------------------------------
// ConnectionCode
// ---------------------------------------------------------------------------

/** A single-use, short-lived artifact bootstrapping GatewayTrust between two devices that have never established a mesh connection (agent-comms#188): `code`/`expiresAt` answer freshness/liveness and are always checked; `signature` is an optional detached PGP signature (armored) over `${code}:${expiresAt}:${deviceId}`, checked only when present, never required -- a device with no PGP identity still generates and redeems a bare code. */
export const ConnectionCodeSchema = defineSchema(
  z.object({
    code: z.string(),
    expiresAt: z.string(),
    deviceId: z.string(),
    signature: z.string().optional(),
  }),
);
export type ConnectionCode = z.infer<typeof ConnectionCodeSchema>;

// ---------------------------------------------------------------------------
// CommsAction
// ---------------------------------------------------------------------------

export const CommsActionSchema = defineSchema(
  z.discriminatedUnion("action", [
    z.object({
      action: z.literal("register"),
      name: z.string(),
      visibility: VisibilitySchema,
      tags: z.array(z.string()),
    }),
    z.object({
      action: z.literal("update"),
      visibility: VisibilitySchema.optional(),
      status: AgentStatusSchema.optional(),
      name: z.string().optional(),
      tags: z.array(z.string()).optional(),
    }),
    z.object({ action: z.literal("whoami") }),
    z.object({ action: z.literal("web_url") }),
    z.object({
      action: z.literal("create_room"),
      name: z.string(),
      type: RoomTypeSchema,
      description: z.string(),
    }),
    z.object({ action: z.literal("list_rooms") }),
    z.object({
      action: z.literal("join_room"),
      room: z.string(),
    }),
    z.object({
      action: z.literal("leave_room"),
      room: z.string(),
    }),
    z.object({
      action: z.literal("send"),
      target: z.string(),
      content: z.string(),
      replyTo: z.string().optional(),
      streamingBehavior: StreamingBehaviorSchema.optional(),
    }),
    z.object({
      action: z.literal("dm"),
      target: z.string(),
      content: z.string(),
      streamingBehavior: StreamingBehaviorSchema.optional(),
    }),
    z.object({ action: z.literal("list_agents") }),
    z.object({
      action: z.literal("read_room"),
      room: z.string(),
      since: z.string().optional(),
    }),
    z.object({
      action: z.literal("invite"),
      room: z.string(),
      agent: z.string(),
    }),
    z.object({
      action: z.literal("kick"),
      room: z.string(),
      agent: z.string(),
    }),
    z.object({
      action: z.literal("decline_invite"),
      room: z.string(),
      reason: z.string(),
    }),
    z.object({
      action: z.literal("destroy_room"),
      room: z.string(),
    }),
    z.object({
      action: z.literal("mesh_connect"),
      host: z.string(),
      port: z.number(),
      policy: z.string().optional(),
    }),
    z.object({
      action: z.literal("mesh_accept"),
      connectionId: z.string(),
    }),
    z.object({
      action: z.literal("mesh_reject"),
      connectionId: z.string(),
      reason: z.string(),
    }),
    z.object({ action: z.literal("mesh_pending") }),
    z.object({
      action: z.literal("room_accept"),
      room: z.string(),
      requesterId: z.string(),
    }),
    z.object({
      action: z.literal("room_reject"),
      room: z.string(),
      requesterId: z.string(),
      reason: z.string().optional(),
    }),
    z.object({ action: z.literal("room_pending") }),
    z.object({
      action: z.literal("capability_accept"),
      requestId: z.string(),
      expires: z.number(),
      delegationsRemaining: z.number().optional(),
      capability: z.string().optional(),
    }),
    z.object({
      action: z.literal("capability_reject"),
      requestId: z.string(),
      reason: z.string().optional(),
    }),
    z.object({ action: z.literal("capability_pending") }),
    z.object({
      action: z.literal("mesh_discover"),
      method: z.string().optional(),
    }),
    z.object({
      action: z.literal("mesh_advertise"),
      method: z.string(),
      name: z.string(),
      port: z.number().optional(),
      adapter: z.string().optional(),
    }),
    z.object({
      action: z.literal("mesh_unadvertise"),
      id: z.string(),
    }),
    z.object({ action: z.literal("mesh_interfaces") }),
    z.object({
      action: z.literal("mesh_listen"),
      host: z.string(),
      port: z.number().optional(),
      policy: z.string().optional(),
    }),
    z.object({
      action: z.literal("mesh_unlisten"),
      id: z.string(),
    }),
    z.object({ action: z.literal("mesh_listeners") }),
    z.object({
      action: z.literal("mesh_set_visibility"),
      visibility: MeshVisibilitySchema,
      adapter: z.string().optional(),
    }),
    z.object({ action: z.literal("mesh_get_visibility") }),
    z.object({
      action: z.literal("gateway_trust"),
      device: z.string(),
      /** When true, `device` is trusted as a user principal (GatewayTrust.addPrincipal, agent-comms#187) rather than a bare remote device-id (agent-comms#193). Omitted or false keeps the original bare-device behaviour. */
      principal: z.boolean().optional(),
    }),
    z.object({
      action: z.literal("gateway_untrust"),
      device: z.string(),
      /** When true, `device` is withdrawn from the principal allowlist (GatewayTrust.removePrincipal, agent-comms#187) rather than the bare-device one (agent-comms#193). Omitted or false keeps the original bare-device behaviour. */
      principal: z.boolean().optional(),
    }),
    z.object({ action: z.literal("gateway_list_trusted") }),
    z.object({
      action: z.literal("gateway_generate_connection_code"),
      ttlMs: z.number().optional(),
      privateKey: z.string().optional(),
      passphrase: z.string().optional(),
    }),
    z.object({
      action: z.literal("gateway_redeem_connection_code"),
      code: z.string(),
      expiresAt: z.string(),
      device: z.string(),
      signature: z.string().optional(),
      publicKey: z.string().optional(),
      fingerprint: z.string().optional(),
    }),
    z.object({
      action: z.literal("query_version"),
      device: z.string(),
    }),
    z.object({ action: z.literal("mesh_graph") }),
    z.object({
      action: z.literal("mesh_trace"),
      target: z.string(),
      timeoutMs: z.number().optional(),
    }),
  ]),
);
export type CommsAction = z.infer<typeof CommsActionSchema>;

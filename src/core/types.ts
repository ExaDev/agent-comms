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

function defineSchema<T extends z.ZodType>(schema: T) {
  return Object.assign(schema, {
    is(value: unknown): value is z.infer<T> {
      return schema.safeParse(value).success;
    },
  });
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

export const MeshVisibility = defineSchema(
  z.union([
    z.literal("discoverable"),
    z.literal("quiet"),
    z.literal("dark"),
  ]),
);
export type MeshVisibility = z.infer<typeof MeshVisibility>;

export const Visibility = defineSchema(
  z.union([z.literal("visible"), z.literal("hidden"), z.literal("ghost")]),
);
export type Visibility = z.infer<typeof Visibility>;

export const AgentStatus = defineSchema(
  z.union([
    z.literal("active"),
    z.literal("idle"),
    z.literal("busy"),
    z.literal("offline"),
  ]),
);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const RoomType = defineSchema(
  z.union([z.literal("public"), z.literal("private"), z.literal("secret")]),
);
export type RoomType = z.infer<typeof RoomType>;

// ---------------------------------------------------------------------------
// AgentIdentity
// ---------------------------------------------------------------------------

export const AgentIdentitySchema = defineSchema(
  z.object({
    id: z.string(),
    name: z.string(),
    harness: z.string(),
    cwd: z.string(),
    pid: z.number(),
    startedAt: z.string(),
    visibility: Visibility,
    status: AgentStatus,
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
    name: z.string(),
    type: RoomType,
    owner: z.string(),
    createdAt: z.string(),
    description: z.string(),
    members: z.array(z.string()),
    invited: z.array(z.string()),
    federated: z.boolean().optional(),
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
  }),
);
export type DmMessage = z.infer<typeof DmMessageSchema>;

export const DeliveryStatus = defineSchema(
  z.union([z.literal("delivered"), z.literal("read")]),
);
export type DeliveryStatus = z.infer<typeof DeliveryStatus>;

// ---------------------------------------------------------------------------
// Delivery events
// ---------------------------------------------------------------------------

export const RoomMemberSchema = defineSchema(
  z.object({
    id: z.string(),
    name: z.string(),
    status: AgentStatus,
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
      status: AgentStatus,
    }),
    z.object({
      type: z.literal("delivery_status"),
      messageId: z.string(),
      agent: z.string(),
      status: DeliveryStatus,
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
// CommsAction
// ---------------------------------------------------------------------------

export const CommsActionSchema = defineSchema(
  z.discriminatedUnion("action", [
    z.object({
      action: z.literal("register"),
      name: z.string(),
      visibility: Visibility,
      tags: z.array(z.string()),
    }),
    z.object({
      action: z.literal("update"),
      visibility: Visibility.optional(),
      status: AgentStatus.optional(),
      name: z.string().optional(),
      tags: z.array(z.string()).optional(),
    }),
    z.object({ action: z.literal("whoami") }),
    z.object({
      action: z.literal("create_room"),
      name: z.string(),
      type: RoomType,
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
    }),
    z.object({
      action: z.literal("dm"),
      target: z.string(),
      content: z.string(),
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
      visibility: MeshVisibility,
      adapter: z.string().optional(),
    }),
    z.object({ action: z.literal("mesh_get_visibility") }),
    // Federation actions (coordinator-to-coordinator)
    z.object({
      action: z.literal("mesh_fed_connect"),
      host: z.string(),
      port: z.number(),
      name: z.string().optional(),
    }),
    z.object({
      action: z.literal("mesh_fed_disconnect"),
      linkId: z.string(),
    }),
    z.object({ action: z.literal("mesh_fed_links") }),
  ]),
);
export type CommsAction = z.infer<typeof CommsActionSchema>;

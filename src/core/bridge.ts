/**
 * Agent Comms — shared bridge helpers.
 *
 * Every bridge needs the same three things:
 *   1. Parse tool parameters into a CommsAction (via Zod schema)
 *   2. Format a DeliveryEvent as human-readable text
 *   3. Register (or recover) an agent identity
 *
 * Extracted here so each bridge only wires up its harness-specific
 * push mechanism and tool registration.
 */

import * as path from "node:path";
import type { CommsStore } from "./comms-store.js";
import type { CommsAction, DeliveryEvent, Visibility } from "./types.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Tool parameter schema — single source of truth for MCP input
// ---------------------------------------------------------------------------

const VisibilityEnum = z.enum(["visible", "hidden", "ghost"]);
const StatusEnum = z.enum(["active", "idle", "busy"]);
const RoomTypeEnum = z.enum(["public", "private", "secret"]);

const MeshVisibilityEnum = z.enum(["discoverable", "quiet", "dark"]);

export const MCP_TOOL_PARAMS = z.object({
  action: z.enum([
    "register",
    "update",
    "whoami",
    "create_room",
    "list_rooms",
    "join_room",
    "leave_room",
    "send",
    "dm",
    "list_agents",
    "read_room",
    "invite",
    "decline_invite",
    "kick",
    "destroy_room",
    "mesh_connect",
    "mesh_accept",
    "mesh_reject",
    "mesh_pending",
    "mesh_discover",
    "mesh_advertise",
    "mesh_unadvertise",
    "mesh_interfaces",
    "mesh_listen",
    "mesh_unlisten",
    "mesh_listeners",
    "mesh_set_visibility",
    "mesh_get_visibility",
    "mesh_fed_connect",
    "mesh_fed_disconnect",
    "mesh_fed_links",
  ]),
  name: z.string().optional(),
  visibility: VisibilityEnum.optional(),
  tags: z.array(z.string()).optional(),
  status: StatusEnum.optional(),
  room: z.string().optional(),
  type: RoomTypeEnum.optional(),
  description: z.string().optional(),
  target: z.string().optional(),
  content: z.string().optional(),
  agent: z.string().optional(),
  since: z.string().optional(),
  replyTo: z.string().optional(),
  reason: z.string().optional(),
  method: z.string().optional(),
  host: z.string().optional(),
  port: z.number().optional(),
  policy: z.string().optional(),
  adapter: z.string().optional(),
  id: z.string().optional(),
  meshVisibility: MeshVisibilityEnum.optional(),
  connectionId: z.string().optional(),
});

export type ToolParams = z.infer<typeof MCP_TOOL_PARAMS>;

/**
 * Zod schema for the MCP tool inputSchema field.
 * This is the same schema exposed directly for the MCP SDK.
 */
// Removed MCP_TOOL_SCHEMA alias — use MCP_TOOL_PARAMS directly

// ---------------------------------------------------------------------------
// buildAction — parsed params → typed CommsAction
// ---------------------------------------------------------------------------

class BuildActionError extends Error {
  constructor(
    public readonly action: string,
    field: string,
  ) {
    super(`Missing required field "${field}" for action "${action}"`);
    this.name = "BuildActionError";
  }
}

export function buildAction(params: Record<string, unknown>): CommsAction {
  const parsed = MCP_TOOL_PARAMS.safeParse(params);
  if (!parsed.success) return { action: "whoami" };
  const p = parsed.data;

  switch (p.action) {
    case "register":
      if (p.name === undefined) throw new BuildActionError("register", "name");
      return {
        action: "register",
        name: p.name,
        visibility: p.visibility ?? "visible",
        tags: p.tags ?? [],
      };
    case "update": {
      const update: CommsAction & { action: "update" } = { action: "update" };
      if (p.visibility !== undefined) update.visibility = p.visibility;
      if (p.status !== undefined) update.status = p.status;
      if (p.name !== undefined) update.name = p.name;
      if (p.tags !== undefined) update.tags = p.tags;
      return update;
    }
    case "whoami":
      return { action: "whoami" };
    case "create_room":
      if (p.room === undefined)
        throw new BuildActionError("create_room", "room");
      return {
        action: "create_room",
        name: p.room,
        type: p.type ?? "public",
        description: p.description ?? "",
      };
    case "list_rooms":
      return { action: "list_rooms" };
    case "join_room":
      if (p.room === undefined) throw new BuildActionError("join_room", "room");
      return { action: "join_room", room: p.room };
    case "leave_room":
      if (p.room === undefined)
        throw new BuildActionError("leave_room", "room");
      return { action: "leave_room", room: p.room };
    case "send": {
      if (p.content === undefined)
        throw new BuildActionError("send", "content");
      if (p.target !== undefined) {
        const send: CommsAction & { action: "send" } = {
          action: "send",
          target: p.target,
          content: p.content,
        };
        if (p.replyTo !== undefined) send.replyTo = p.replyTo;
        return send;
      }
      if (p.room !== undefined) {
        const send: CommsAction & { action: "send" } = {
          action: "send",
          target: p.room,
          content: p.content,
        };
        if (p.replyTo !== undefined) send.replyTo = p.replyTo;
        return send;
      }
      throw new BuildActionError("send", "target");
    }
    case "dm": {
      if (p.content === undefined) throw new BuildActionError("dm", "content");
      if (p.target !== undefined) {
        return { action: "dm", target: p.target, content: p.content };
      }
      if (p.agent !== undefined) {
        return { action: "dm", target: p.agent, content: p.content };
      }
      throw new BuildActionError("dm", "target");
    }
    case "list_agents":
      return { action: "list_agents" };
    case "read_room":
      if (p.room === undefined) throw new BuildActionError("read_room", "room");
      return {
        action: "read_room",
        room: p.room,
        ...(p.since !== undefined && { since: p.since }),
      };
    case "invite":
      if (p.room === undefined) throw new BuildActionError("invite", "room");
      if (p.agent === undefined) throw new BuildActionError("invite", "agent");
      return { action: "invite", room: p.room, agent: p.agent };
    case "decline_invite":
      if (p.room === undefined)
        throw new BuildActionError("decline_invite", "room");
      if (p.reason === undefined)
        throw new BuildActionError("decline_invite", "reason");
      return { action: "decline_invite", room: p.room, reason: p.reason };
    case "kick":
      if (p.room === undefined) throw new BuildActionError("kick", "room");
      if (p.agent === undefined) throw new BuildActionError("kick", "agent");
      return { action: "kick", room: p.room, agent: p.agent };
    case "destroy_room":
      if (p.room === undefined)
        throw new BuildActionError("destroy_room", "room");
      return { action: "destroy_room", room: p.room };
    case "mesh_connect": {
      if (p.host === undefined)
        throw new BuildActionError("mesh_connect", "host");
      if (p.port === undefined)
        throw new BuildActionError("mesh_connect", "port");
      return {
        action: "mesh_connect",
        host: p.host,
        port: p.port,
        ...(p.policy !== undefined && { policy: p.policy }),
      };
    }
    case "mesh_accept": {
      if (p.connectionId === undefined)
        throw new BuildActionError("mesh_accept", "connectionId");
      return { action: "mesh_accept", connectionId: p.connectionId };
    }
    case "mesh_reject": {
      if (p.connectionId === undefined)
        throw new BuildActionError("mesh_reject", "connectionId");
      if (p.reason === undefined)
        throw new BuildActionError("mesh_reject", "reason");
      return {
        action: "mesh_reject",
        connectionId: p.connectionId,
        reason: p.reason,
      };
    }
    case "mesh_pending":
      return { action: "mesh_pending" };
    case "mesh_discover": {
      const discover: CommsAction & { action: "mesh_discover" } = {
        action: "mesh_discover",
      };
      if (p.method !== undefined) discover.method = p.method;
      return discover;
    }
    case "mesh_advertise":
      if (p.name === undefined)
        throw new BuildActionError("mesh_advertise", "name");
      if (p.method === undefined)
        throw new BuildActionError("mesh_advertise", "method");
      return {
        action: "mesh_advertise",
        method: p.method,
        name: p.name,
        ...(p.port !== undefined && { port: p.port }),
        ...(p.adapter !== undefined && { adapter: p.adapter }),
      };
    case "mesh_unadvertise":
      if (p.id === undefined)
        throw new BuildActionError("mesh_unadvertise", "id");
      return { action: "mesh_unadvertise", id: p.id };
    case "mesh_interfaces":
      return { action: "mesh_interfaces" };
    case "mesh_listen":
      if (p.host === undefined) throw new BuildActionError("mesh_listen", "host");
      return {
        action: "mesh_listen",
        host: p.host,
        ...(p.port !== undefined && { port: p.port }),
        ...(p.policy !== undefined && { policy: p.policy }),
      };
    case "mesh_unlisten":
      if (p.id === undefined) throw new BuildActionError("mesh_unlisten", "id");
      return { action: "mesh_unlisten", id: p.id };
    case "mesh_listeners":
      return { action: "mesh_listeners" };
    case "mesh_set_visibility": {
      if (p.meshVisibility === undefined) {
        throw new BuildActionError("mesh_set_visibility", "meshVisibility");
      }
      const result: CommsAction & { action: "mesh_set_visibility" } = {
        action: "mesh_set_visibility",
        visibility: p.meshVisibility,
      };
      if (p.adapter !== undefined) result.adapter = p.adapter;
      return result;
    }
    case "mesh_get_visibility": {
      const result: CommsAction & { action: "mesh_get_visibility" } = {
        action: "mesh_get_visibility",
      };
      return result;
    }
    case "mesh_fed_connect": {
      if (p.host === undefined) throw new BuildActionError("mesh_fed_connect", "host");
      if (p.port === undefined) throw new BuildActionError("mesh_fed_connect", "port");
      const result: CommsAction & { action: "mesh_fed_connect" } = {
        action: "mesh_fed_connect",
        host: p.host,
        port: p.port,
      };
      if (p.name !== undefined) result.name = p.name;
      return result;
    }
    case "mesh_fed_disconnect":
      if (p.id === undefined) throw new BuildActionError("mesh_fed_disconnect", "id");
      return { action: "mesh_fed_disconnect", linkId: p.id };
    case "mesh_fed_links":
      return { action: "mesh_fed_links" };
  }
}

// ---------------------------------------------------------------------------
// formatDeliveryEvent — DeliveryEvent → human-readable string
// ---------------------------------------------------------------------------

export function formatDeliveryEvent(event: DeliveryEvent): string {
  switch (event.type) {
    case "room_message":
      return `[${event.message.room}] ${event.message.from}: ${event.message.content}`;
    case "dm":
      return `DM from ${event.message.from}: ${event.message.content}`;
    case "room_invite": {
      const desc = event.roomDescription ? ` — ${event.roomDescription}` : "";
      const who = event.fromCwd
        ? `${event.fromName} (${event.fromCwd})`
        : event.fromName;
      return `${who} invited you to room "${event.room}"${desc}`;
    }
    case "member_joined":
      return `${event.agent} joined ${event.room}`;
    case "member_left":
      return `${event.agent} left ${event.room}`;
    case "room_members": {
      const names = event.members
        .map((m) => `${m.name} (${m.status})`)
        .join(", ");
      return `Room ${event.room} members: ${names}`;
    }
    case "member_status":
      return `${event.agent} is now ${event.status} in ${event.room}`;
    case "delivery_status":
      return `Message ${event.messageId} ${event.status} by ${event.agent}${event.room ? ` in ${event.room}` : ""}`;
    case "invite_declined":
      return `${event.agentName} declined invite to ${event.room}: "${event.reason}"`;
    case "name_changed":
      return `${event.oldName} is now known as ${event.newName}`;
    case "connection_request":
      return `Connection request from ${event.peerId} (${event.name}) fingerprint ${event.fingerprint}`;
  }
}

// ---------------------------------------------------------------------------
// Event classification — actionable vs informational
// ---------------------------------------------------------------------------

/**
 * Classify a delivery event as actionable (requires model attention)
 * or informational (can be buffered and returned with next tool call).
 *
 * Actionable: DMs, room messages, room invites — the model may need to respond.
 * Informational: status changes, joins/leaves, renames, read receipts —
 *   the model may need to know eventually but never needs to act immediately.
 */
export function isActionableEvent(event: DeliveryEvent): boolean {
  switch (event.type) {
    case "dm":
    case "room_message":
    case "room_invite":
      return true;
    case "member_joined":
    case "member_left":
    case "room_members":
    case "member_status":
    case "delivery_status":
    case "invite_declined":
    case "name_changed":
    case "connection_request":
      return false;
  }
}

// ---------------------------------------------------------------------------
// ensureRegistered — recover or create an agent identity
// ---------------------------------------------------------------------------

export interface RegistrationResult {
  agentId: string;
  store: CommsStore;
  isNew: boolean;
}

/**
 * Recover an existing identity (from `identity.json`) or register a new agent.
 * Returns the agent ID and whether this was a fresh registration.
 */
export async function ensureRegistered(opts: {
  store: CommsStore;
  harness: string;
  cwd: string;
  defaultName: string;
  visibility?: Visibility;
  tags?: string[];
}): Promise<RegistrationResult> {
  await opts.store.init();

  const identity = await opts.store.readIdentity(opts.harness, opts.cwd);
  if (identity) {
    await opts.store.updateAgent(identity.id, {
      status: "active",
      pid: process.pid,
    });
    await ensureProjectRoom(opts.store, identity.id, opts.cwd);
    return { agentId: identity.id, store: opts.store, isNew: false };
  }

  const agent = await opts.store.registerAgent({
    name: opts.defaultName,
    harness: opts.harness,
    cwd: opts.cwd,
    pid: process.pid,
    visibility: opts.visibility ?? "visible",
    tags: opts.tags ?? [],
  });
  await ensureProjectRoom(opts.store, agent.id, opts.cwd);
  return { agentId: agent.id, store: opts.store, isNew: true };
}

// ---------------------------------------------------------------------------
// ensureProjectRoom — auto-create a room for the agent's working directory
// ---------------------------------------------------------------------------

/**
 * Ensure a project room exists for the given cwd and the agent is a member.
 * Creates the room if needed and joins the agent. No-op if already a member.
 * Returns the room ID.
 */
export async function ensureProjectRoom(
  store: CommsStore,
  agentId: string,
  cwd: string,
): Promise<string> {
  const basename = path.basename(cwd);

  // Check if the room already exists
  const existing = await store.getRoom(basename);
  if (existing) {
    // Room exists — verify it's a project room (description matches pattern)
    if (!existing.members.includes(agentId)) {
      await store.joinRoom(basename, agentId);
    }
    return basename;
  }

  // Create — createRoom auto-joins the owner
  await store.createRoom({
    name: basename,
    type: "public",
    owner: agentId,
    description: `Project room for ${cwd}`,
  });

  return basename;
}

// ---------------------------------------------------------------------------
// drainAndFormat — drain delivery queue, return formatted lines
// ---------------------------------------------------------------------------

export async function drainAndFormat(
  store: CommsStore,
  agentId: string,
): Promise<string[]> {
  const events = await store.drainDelivery(agentId);
  return events.map(formatDeliveryEvent);
}

/**
 * Room-state and inviter-agent wire extensions riding room.join/room.members/room.invite's own open extension tails (P3.6/P3.8) -- agent-comms' own application data convention, since core/room itself has no concept of a display name, description, or inviter identity. Split out of MeshStore as plain functions (the originals were `private static` methods with zero `this` access) because both room-protocol.ts and room-lifecycle.ts need them.
 */

import { RoomType } from "./types.js";
import type { AgentIdentity, Room } from "./types.js";

/**
 * Room metadata (name/description/type) riding room-join-ok/room-members-ok's own open extension tail (P3.6), agent-comms' own convention for the "namespaced room-state extension" the design names -- core/room itself has no concept of a display name or description, so this is application data, not a wire-level field. Absent entirely for a DM path (room is undefined there; a DM has no name/description/type to report) rather than a hollow placeholder.
 */
export function roomStateExtension(room: Readonly<Room> | undefined): {
  "room-state"?: { name: string; description: string; type: RoomType };
} {
  if (room === undefined) return {};
  return {
    "room-state": {
      name: room.name,
      description: room.description,
      type: room.type,
    },
  };
}

/** The receiving-side counterpart of roomStateExtension: narrows an incoming response's own "room-state" field (an unknown, since it rides the wire schema's open catchall tail) to the shape this store's own convention actually sends, or undefined for a peer running without it (an older version, or a DM's own room-join-ok, which never carries one). */
export function parseRoomStateExtension(
  value: unknown,
): { name: string; description: string; type: RoomType } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (!("name" in value) || !("description" in value) || !("type" in value))
    return undefined;
  if (typeof value.name !== "string" || typeof value.description !== "string")
    return undefined;
  const parsedType = RoomType.safeParse(value.type);
  if (!parsedType.success) return undefined;
  return {
    name: value.name,
    description: value.description,
    type: parsedType.data,
  };
}

/**
 * The inviter's own display name and cwd, riding room-invite's own open extension tail -- agent-comms' own application data, the same convention roomStateExtension already establishes for room metadata. Unlike room-state (which needs gossip on the requester's own side of room.join/members), the inviter here is always this store's own local agent record: inviteToRoom only ever succeeds for the room's real owner, which per this store's own organising fact (one bridge is one agent is one device) is always this.peerId, so the record is always this store's own registration, never a gossip-dependent lookup.
 */
export function inviterAgentExtension(inviter: Readonly<AgentIdentity>): {
  "inviter-agent": { name: string; cwd: string };
} {
  return { "inviter-agent": { name: inviter.name, cwd: inviter.cwd } };
}

/** The receiving-side counterpart of inviterAgentExtension: narrows an incoming room.invite's own "inviter-agent" field to the shape this store's own convention sends, or undefined for a peer running without it (an older version) -- the caller falls back to the inviter's bare device-id in that case, the same honest degradation parseRoomStateExtension's own absent case already accepts. */
export function parseInviterAgentExtension(
  value: unknown,
): { name: string; cwd: string } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (!("name" in value) || !("cwd" in value)) return undefined;
  if (typeof value.name !== "string" || typeof value.cwd !== "string")
    return undefined;
  return { name: value.name, cwd: value.cwd };
}

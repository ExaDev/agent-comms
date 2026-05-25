/**
 * URL query parameter sync — deep-linking for rooms, DMs, and project rooms.
 *
 * Supported parameters (mutually exclusive, first match wins):
 *   ?room=<roomId>   — join a room by ID
 *   ?dm=<agentId>    — open a DM conversation with an agent
 *   ?cwd=<path>      — find the project room for a working directory and join it
 *
 * The URL bar updates on every navigation (room join, agent select, leave)
 * so the current view is always shareable. Uses replaceState to avoid
 * polluting browser history.
 */

import type { Room } from "./types.js";

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface NavTarget {
  kind: "room";
  roomId: string;
}

export interface NavTargetDm {
  kind: "dm";
  agentId: string;
}

export interface NavTargetCwd {
  kind: "cwd";
  path: string;
}

export type DeepLink = NavTarget | NavTargetDm | NavTargetCwd;

const PROJECT_ROOM_PREFIX = "Project room for ";

/**
 * Parse query parameters into a deep link target.
 * Returns undefined if no recognised parameter is present.
 */
export function parseDeepLink(search: string): DeepLink | undefined {
  const params = new URLSearchParams(search);

  const room = params.get("room");
  if (room) return { kind: "room", roomId: room };

  const dm = params.get("dm");
  if (dm) return { kind: "dm", agentId: dm };

  const cwd = params.get("cwd");
  if (cwd) return { kind: "cwd", path: cwd };

  return undefined;
}

// ---------------------------------------------------------------------------
// Resolution — turn a DeepLink into a concrete action given current data
// ---------------------------------------------------------------------------

export interface ResolvedNav {
  kind: "room" | "dm";
  targetId: string;
}

/**
 * Resolve a deep link against the current rooms list.
 *
 * - room → direct match by ID
 * - dm   → direct match by agent ID
 * - cwd  → find a project room whose description is "Project room for <path>"
 */
export function resolveDeepLink(
  link: DeepLink,
  rooms: Room[],
): ResolvedNav | undefined {
  switch (link.kind) {
    case "room":
      if (rooms.some((r) => r.id === link.roomId)) {
        return { kind: "room", targetId: link.roomId };
      }
      return undefined;

    case "dm":
      return { kind: "dm", targetId: link.agentId };

    case "cwd": {
      const projectRoom = rooms.find(
        (r) => r.description === `${PROJECT_ROOM_PREFIX}${link.path}`,
      );
      if (projectRoom) {
        return { kind: "room", targetId: projectRoom.id };
      }
      return undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// URL sync — keep the address bar reflecting the current view
// ---------------------------------------------------------------------------

export function syncUrl(params: {
  currentRoom: string | undefined;
  dmTarget: string | undefined;
}): void {
  const url = new URL(location.href);

  // Clear previous nav params
  url.searchParams.delete("room");
  url.searchParams.delete("dm");
  url.searchParams.delete("cwd");

  if (params.currentRoom) {
    url.searchParams.set("room", params.currentRoom);
  } else if (params.dmTarget) {
    url.searchParams.set("dm", params.dmTarget);
  }

  const next = url.pathname + url.search + url.hash;
  history.replaceState(null, "", next);
}

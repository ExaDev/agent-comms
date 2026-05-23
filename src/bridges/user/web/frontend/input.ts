/**
 * Input handler — parse slash commands and plain messages.
 *
 * Pure logic, no DOM dependency. Returns an Action or a local command result.
 * Testable in isolation.
 */

import type { Action } from "./types.js";

// ---------------------------------------------------------------------------
// Command result (handled locally, not sent to server)
// ---------------------------------------------------------------------------

export interface LocalResult {
  type: "help" | "unknown" | "error";
  text: string;
}

export type InputResult =
  | { kind: "action"; action: Action }
  | { kind: "local"; result: LocalResult }
  | { kind: "ignored" };

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export function parseInput(
  text: string,
  currentRoom: string | undefined,
  dmTarget: string | undefined = undefined,
): InputResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { kind: "ignored" };

  if (trimmed.startsWith("/")) {
    return parseCommand(trimmed, currentRoom);
  }

  if (currentRoom) {
    return {
      kind: "action",
      action: { action: "send", target: currentRoom, content: trimmed },
    };
  }

  if (dmTarget) {
    return {
      kind: "action",
      action: { action: "dm", target: dmTarget, content: trimmed },
    };
  }

  return {
    kind: "local",
    result: {
      type: "error",
      text: "Join a room or select an agent first",
    },
  };
}

function parseCommand(
  text: string,
  currentRoom: string | undefined,
): InputResult {
  const parts = text.slice(1).split(/\s+/);
  const cmd = (parts[0] ?? "").toLowerCase();

  switch (cmd) {
    case "join":
      if (!parts[1]) {
        return {
          kind: "local",
          result: { type: "error", text: "Usage: /join <room>" },
        };
      }
      return {
        kind: "action",
        action: { action: "join_room", room: parts[1] },
      };

    case "leave":
      return {
        kind: "action",
        action: {
          action: "leave_room",
          room: parts[1] ?? currentRoom ?? "",
        },
      };

    case "rooms":
      return {
        kind: "action",
        action: { action: "list_rooms" },
      };

    case "agents":
      return {
        kind: "action",
        action: { action: "list_agents" },
      };

    case "dm":
      if (!parts[1] || !parts[2]) {
        return {
          kind: "local",
          result: {
            type: "error",
            text: "Usage: /dm <agent> <message>",
          },
        };
      }
      return {
        kind: "action",
        action: {
          action: "dm",
          target: parts[1],
          content: parts.slice(2).join(" "),
        },
      };

    case "create":
      if (!parts[1]) {
        return {
          kind: "local",
          result: { type: "error", text: "Usage: /create <name>" },
        };
      }
      return {
        kind: "action",
        action: {
          action: "create_room",
          name: parts[1],
          type: "public",
        },
      };

    case "destroy":
      if (!parts[1]) {
        return {
          kind: "local",
          result: { type: "error", text: "Usage: /destroy <room>" },
        };
      }
      return {
        kind: "action",
        action: { action: "destroy_room", room: parts[1] },
      };

    case "help":
      return {
        kind: "local",
        result: {
          type: "help",
          text: "Commands: /join, /leave, /rooms, /agents, /dm, /create, /destroy, /help",
        },
      };

    default:
      return {
        kind: "local",
        result: { type: "unknown", text: `Unknown command: /${cmd}` },
      };
  }
}

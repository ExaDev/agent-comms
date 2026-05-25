/**
 * TUI — terminal chat interface using readline + ANSI escape codes.
 *
 * Commands:
 *   /join <room>      Join or switch to a room
 *   /leave [room]     Leave the current (or specified) room
 *   /rooms            List all rooms
 *   /agents           List all agents
 *   /read [room]      Read messages in current (or specified) room
 *   /dm <agent> <msg> Send a direct message
 *   /create <name>    Create a public room
 *   /invite <room> <agent>  Invite an agent to a room
 *   /decline <room> <reason> Decline a room invite
 *   /kick <room> <agent>    Kick an agent from a room
 *   /destroy <room>   Destroy a room
 *   /help             Show commands
 *   /quit             Exit
 *
 * Anything without / is sent to the current room.
 */

import * as readline from "node:readline";
import { ChatController } from "./controller.js";
import type { DeliveryEvent } from "../../core/types.js";

// ANSI helpers
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";
const RESET = "\x1b[0m";
const CLEAR_LINE = "\r\x1b[2K";

function prompt(controller: ChatController): string {
  const room = controller.activeRoom;
  return room ? `${GREEN}${room}${RESET} > ` : `${DIM}>${RESET} `;
}

export async function runTui(userName: string): Promise<void> {
  const controller = new ChatController(userName);

  await controller.init();
  console.log(
    `${CYAN}Connected as ${BOLD}${userName} (user)${RESET} [${controller.agentId}]`,
  );
  console.log(
    `${DIM}Type /help for commands. Anything else goes to the current room.${RESET}\n`,
  );

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // Delivery event handler — print above the prompt
  function onMessage(event: DeliveryEvent): void {
    const line = formatForTerminal(event);
    process.stdout.write(`${CLEAR_LINE}${line}\n${prompt(controller)}`);
  }
  controller.on("message", onMessage);

  function onError(err: Error): void {
    process.stdout.write(
      `${CLEAR_LINE}${RED}Error: ${err.message}${RESET}\n${prompt(controller)}`,
    );
  }
  controller.on("error", onError);

  // Input loop
  async function handleInput(input: string): Promise<void> {
    const trimmed = input.trim();
    if (trimmed.length === 0) return;

    if (trimmed.startsWith("/")) {
      await handleCommand(trimmed, controller);
    } else if (controller.activeRoom) {
      const result = await controller.sendToCurrentRoom(trimmed);
      if (result.isError) {
        process.stdout.write(`${RED}${result.content}${RESET}\n`);
      }
    } else {
      process.stdout.write(
        `${YELLOW}No active room. /join a room first or use /dm.${RESET}\n`,
      );
    }
  }

  function ask(): void {
    rl.question(prompt(controller), (input) => {
      void handleInput(input).then(() => {
        ask();
      });
    });
  }

  ask();

  // Graceful shutdown
  rl.on("close", () => {
    controller.off("message", onMessage);
    controller.off("error", onError);
    void controller.shutdown().then(() => process.exit(0));
  });
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

async function handleCommand(input: string, c: ChatController): Promise<void> {
  const parts = input.slice(1).split(/\s+/);
  const cmd = parts[0]?.toLowerCase();
  const arg1 = parts[1];
  const arg2 = parts.slice(2).join(" ");

  switch (cmd) {
    case "join": {
      if (!arg1) {
        process.stdout.write(`${YELLOW}Usage: /join <room>${RESET}\n`);
        return;
      }
      const result = await c.switchRoom(arg1);
      printResult(result);
      if (!result.isError) {
        const read = await c.readRoom();
        if (!read.isError && read.content !== "No messages.") {
          process.stdout.write(`${DIM}${read.content}${RESET}\n`);
        }
      }
      return;
    }
    case "leave": {
      const result = await c.leaveRoom(arg1);
      printResult(result);
      return;
    }
    case "rooms": {
      const result = await c.listRooms();
      printResult(result);
      return;
    }
    case "agents": {
      const result = await c.listAgents();
      printResult(result);
      return;
    }
    case "read": {
      const result = await c.readRoom(arg1);
      printResult(result);
      return;
    }
    case "dm": {
      if (!arg1 || !arg2) {
        process.stdout.write(`${YELLOW}Usage: /dm <agent> <message>${RESET}\n`);
        return;
      }
      const result = await c.dm(arg1, arg2);
      printResult(result);
      return;
    }
    case "create": {
      if (!arg1) {
        process.stdout.write(`${YELLOW}Usage: /create <name>${RESET}\n`);
        return;
      }
      const result = await c.createRoom(arg1, "public", arg2);
      printResult(result);
      return;
    }
    case "invite": {
      const agentId = parts[2];
      if (!arg1 || !agentId) {
        process.stdout.write(
          `${YELLOW}Usage: /invite <room> <agent>${RESET}\n`,
        );
        return;
      }
      const result = await c.invite(arg1, agentId);
      printResult(result);
      return;
    }
    case "decline": {
      const reason = parts.slice(2).join(" ");
      if (!arg1 || !reason) {
        process.stdout.write(
          `${YELLOW}Usage: /decline <room> <reason>${RESET}\n`,
        );
        return;
      }
      const result = await c.declineInvite(arg1, reason);
      printResult(result);
      return;
    }
    case "kick": {
      const agentId = parts[2];
      if (!arg1 || !agentId) {
        process.stdout.write(`${YELLOW}Usage: /kick <room> <agent>${RESET}\n`);
        return;
      }
      const result = await c.kick(arg1, agentId);
      printResult(result);
      return;
    }
    case "destroy": {
      if (!arg1) {
        process.stdout.write(`${YELLOW}Usage: /destroy <room>${RESET}\n`);
        return;
      }
      const result = await c.destroyRoom(arg1);
      printResult(result);
      return;
    }
    case "help":
      process.stdout.write(`${CYAN}Commands:${RESET}
  ${GREEN}/join${RESET} <room>         Join or switch to a room
  ${GREEN}/leave${RESET} [room]        Leave current (or specified) room
  ${GREEN}/rooms${RESET}               List all rooms
  ${GREEN}/agents${RESET}              List all agents
  ${GREEN}/read${RESET} [room]         Read messages in room
  ${GREEN}/dm${RESET} <agent> <msg>    Send a direct message
  ${GREEN}/create${RESET} <name>       Create a public room
  ${GREEN}/invite${RESET} <room> <id>  Invite agent to room
  ${GREEN}/decline${RESET} <room> <reason> Decline a room invite
  ${GREEN}/kick${RESET} <room> <id>    Kick agent from room
  ${GREEN}/destroy${RESET} <room>      Destroy a room
  ${GREEN}/help${RESET}                Show this help
  ${GREEN}/quit${RESET}                Exit
\n${DIM}Anything without / is sent to the current room.${RESET}\n`);
      return;
    case "quit":
      process.stdout.write(`${DIM}Goodbye!${RESET}\n`);
      process.exit(0);
    default:
      process.stdout.write(
        `${YELLOW}Unknown command: /${String(cmd)}. Type /help for commands.${RESET}\n`,
      );
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function printResult(result: { content: string; isError: boolean }): void {
  if (result.isError) {
    process.stdout.write(`${RED}${result.content}${RESET}\n`);
  } else {
    process.stdout.write(`${result.content}\n`);
  }
}

function formatForTerminal(event: DeliveryEvent): string {
  switch (event.type) {
    case "room_message":
      return `${BOLD}[${event.message.room}] ${event.message.from}:${RESET} ${event.message.content}`;
    case "dm":
      return `${MAGENTA}DM from ${event.message.from}:${RESET} ${event.message.content}`;
    case "member_joined":
      return `${GREEN}→ ${event.agent} joined ${event.room}${RESET}`;
    case "member_left":
      return `${YELLOW}← ${event.agent} left ${event.room}${RESET}`;
    case "member_status":
      return `${CYAN}● ${event.agent} is now ${event.status} in ${event.room}${RESET}`;
    case "delivery_status":
      return `${DIM}✓ Message ${event.messageId} ${event.status} by ${event.agent}${RESET}`;
    case "room_invite": {
      const desc = event.roomDescription ? ` — ${event.roomDescription}` : "";
      return `${CYAN}✉ ${event.fromName} invited you to "${event.room}"${desc}${RESET}`;
    }
    case "invite_declined":
      return `${YELLOW}✗ ${event.agentName} declined invite to ${event.room}: "${event.reason}"${RESET}`;
    case "room_members": {
      const names = event.members
        .map((m) => `${m.name} (${m.status})`)
        .join(", ");
      return `${DIM}Members of ${event.room}: ${names}${RESET}`;
    }
    case "name_changed":
      return `${CYAN}✎ ${event.oldName} is now ${event.newName}${RESET}`;
  }
}

/**
 * Non-interactive CLI — one-shot commands that register, execute, print, and exit.
 *
 * Usage:
 *   agent-comms send <room> <message>
 *   agent-comms dm <agent> <message>
 *   agent-comms rooms
 *   agent-comms agents
 *   agent-comms read <room> [--since <iso>]
 */

import { ChatController } from "./controller.js";

export async function runCli(
  command: string,
  args: readonly string[],
  userName: string,
): Promise<void> {
  const controller = new ChatController(userName);

  try {
    await controller.init();

    const result = await dispatch(controller, command, args);

    if (result.isError) {
      console.error(result.content);
      process.exit(1);
    } else {
      console.log(result.content);
    }
  } finally {
    await controller.shutdown();
  }
}

async function dispatch(
  controller: ChatController,
  command: string,
  args: readonly string[],
): Promise<{ content: string; isError: boolean }> {
  switch (command) {
    case "send": {
      const room = args[0];
      const content = args.slice(1).join(" ");
      if (room === undefined || room === "" || !content) {
        return {
          content: "Usage: agent-comms send <room> <message>",
          isError: true,
        };
      }
      // Ensure we're in the room
      const joinResult = await controller.switchRoom(room);
      if (joinResult.isError) return joinResult;
      return controller.send(room, content);
    }
    case "dm": {
      const agent = args[0];
      const content = args.slice(1).join(" ");
      if (agent === undefined || agent === "" || !content) {
        return {
          content: "Usage: agent-comms dm <agent-id> <message>",
          isError: true,
        };
      }
      return controller.dm(agent, content);
    }
    case "rooms":
      return controller.listRooms();
    case "agents":
      return controller.listAgents();
    case "read": {
      const room = args[0];
      if (room === undefined || room === "") {
        return {
          content: "Usage: agent-comms read <room> [--since <iso>]",
          isError: true,
        };
      }
      const sinceIdx = args.indexOf("--since");
      const since = sinceIdx !== -1 ? args[sinceIdx + 1] : undefined;
      return controller.readRoom(room, since);
    }
    default:
      return { content: `Unknown command: ${command}`, isError: true };
  }
}

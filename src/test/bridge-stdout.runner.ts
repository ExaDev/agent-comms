/**
 * Child-process entry for mcp-stdout-channel.integration.test.ts: starts one of the real bridge entry points against an isolated mesh, with its ports, hub and identity directory taken from a JSON argument, so the test can own the process's stdin and read its stdout and stderr. The entry is named by the argument: the MCP bridge's own run(), the claude-code bridge's run(), or the command line's dispatch of a bare `agent-comms`.
 */

import { z } from "zod";
import { run as runClaudeCode } from "../bridges/claude-code/channel.js";
import { run as runMcp } from "../bridges/mcp/server.js";
import { main } from "../cli-main.js";

const argumentSchema = z.object({
  entry: z.enum(["mcp", "claude-code", "bare-command"]),
  coordinatorPort: z.number(),
  firstContactPort: z.number(),
  hubUrl: z.string(),
  slotDir: z.string(),
});

const raw = process.argv[2];
if (raw === undefined) {
  throw new Error("expected a JSON argument");
}
const args = argumentSchema.parse(JSON.parse(raw));

const mesh = {
  coordinatorPort: args.coordinatorPort,
  firstContactPort: args.firstContactPort,
  hubUrl: args.hubUrl,
};

switch (args.entry) {
  case "mcp":
    await runMcp({
      mesh,
      slot: { harness: "mcp", cwd: process.cwd(), dir: args.slotDir },
    });
    break;
  case "claude-code":
    await runClaudeCode({
      mesh,
      slot: { harness: "claude-code", cwd: process.cwd(), dir: args.slotDir },
    });
    break;
  case "bare-command":
    main({
      args: [],
      stdinIsTerminal: process.stdin.isTTY,
      bridge: {
        mesh,
        slot: { harness: "mcp", cwd: process.cwd(), dir: args.slotDir },
      },
    });
    break;
}

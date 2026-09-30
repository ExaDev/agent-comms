/**
 * Child-process entry for mcp-stdout-channel.integration.test.ts: runs the real MCP bridge (bridges/mcp/server.ts) against an isolated mesh, with its ports, hub and identity directory taken from a JSON argument, so the test can own the process's stdin and read exactly what it writes to stdout.
 */

import { z } from "zod";
import { run } from "../bridges/mcp/server.js";

const argumentSchema = z.object({
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

await run({
  mesh: {
    coordinatorPort: args.coordinatorPort,
    firstContactPort: args.firstContactPort,
    hubUrl: args.hubUrl,
  },
  slot: { harness: "mcp", cwd: process.cwd(), dir: args.slotDir },
});

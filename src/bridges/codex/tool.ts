/**
 * Agent Comms — Codex MCP tool server.
 *
 * Provides the "agent_comms" tool for Codex to call.
 * Uses TCP mesh for state sync. Pending messages are drained and
 * appended to every tool response so Codex sees them mid-turn.
 *
 * Run via: npx agent-comms bridge codex
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  MeshStore,
  CommsTool,
  buildAction,
  ensureRegistered,
  drainAndFormat,
  MCP_TOOL_PARAMS,
} from "../../core/index.js";
import { TlsTransport } from "../../core/tls-transport.js";
import { generateIdentity } from "../../core/identity.js";
import { tryStartWebServer } from "../user/web/server.js";
import { nanoid } from "../../core/nanoid.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function run(): Promise<void> {
  const identity = generateIdentity();
  const store = new MeshStore();
  store.peerId = identity.fingerprint;
  store.setTransport(new TlsTransport(store.events, identity));
  const tool = new CommsTool(store);
  let agentId: string | undefined;

  const mcp = new McpServer(
    { name: "agent-comms", version: "0.2.0" },
    { capabilities: {} },
  );

  // -----------------------------------------------------------------------
  // Tool registration
  // -----------------------------------------------------------------------

  mcp.registerTool(
    "agent_comms",
    {
      description: [
        "Cross-harness agent communication mesh. Actions:",
        "register, update, whoami, create_room, list_rooms, join_room, leave_room,",
        "send, dm, list_agents, read_room, invite, decline_invite, kick, destroy_room.",
        "Pending incoming messages are included in every response.",
      ].join(" "),
      inputSchema: MCP_TOOL_PARAMS,
    },
    async (rawParams: unknown) => {
      const params = isRecord(rawParams) ? rawParams : {};
      const actionParam = params.action;
      if (!agentId) {
        const name =
          actionParam === "register" && typeof params.name === "string"
            ? params.name
            : `codex-${nanoid(4)}`;
        const reg = await ensureRegistered({
          cwd: process.cwd(),
          store,
          harness: "codex",
          defaultName: name,
        });
        agentId = reg.agentId;
      }

      const action = buildAction(params);
      const result = await tool.handle(
        { agentId, harness: "codex", cwd: process.cwd(), pid: process.pid },
        action,
      );

      // Drain pending delivery messages and append to response
      const deliveryLines = await drainAndFormat(store, agentId);
      const content: { type: "text"; text: string }[] = [
        { type: "text", text: result.content },
      ];

      if (deliveryLines.length > 0) {
        content.push({
          type: "text",
          text: "📬 Incoming messages:\n" + deliveryLines.join("\n"),
        });
      }

      return { content, isError: result.isError };
    },
  );

  // -----------------------------------------------------------------------
  // Startup
  // -----------------------------------------------------------------------

  await store.init();
  await tryStartWebServer();
  await mcp.connect(new StdioServerTransport());

  const reg = await ensureRegistered({
    cwd: process.cwd(),
    store,
    harness: "codex",
    defaultName: `codex-${nanoid(4)}`,
  });
  agentId = reg.agentId;
}

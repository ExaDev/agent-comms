/**
 * Agent Comms — Claude Code channel bridge.
 *
 * MCP channel server that provides the "agent_comms" tool and pushes
 * incoming messages into Claude's context via <channel> events.
 * Uses TCP mesh for real-time delivery — no filesystem polling.
 *
 * Run via: npx agent-comms bridge claude-code
 * Requires: claude --dangerously-load-development-channels
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  MeshStore,
  CommsTool,
  buildAction,
  ensureRegistered,
  formatDeliveryEvent,
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
  const tool = new CommsTool(store, store.discovery);
  let agentId: string | undefined;

  const mcp = new McpServer(
    { name: "agent-comms", version: "0.2.0" },
    {
      capabilities: {
        experimental: { "claude/channel": {} },
      },
    },
  );

  // Incoming messages arrive via TCP mesh — push as channel notifications
  store.onDelivery = async (_targetId: string, event) => {
    const line = formatDeliveryEvent(event);
    await mcp.server.notification({
      method: "notifications/claude/channel",
      params: { content: line, meta: {} },
    });
  };

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
        'Incoming messages appear as <channel source="agent-comms"> events.',
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
            : `claude-code-${nanoid(4)}`;
        const reg = await ensureRegistered({
          cwd: process.cwd(),
          store,
          harness: "claude-code",
          defaultName: name,
        });
        agentId = reg.agentId;
      }

      const action = buildAction(params);
      const result = await tool.handle(
        {
          agentId,
          harness: "claude-code",
          cwd: process.cwd(),
          pid: process.pid,
        },
        action,
      );

      return {
        content: [{ type: "text", text: result.content }],
        isError: result.isError,
      };
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
    harness: "claude-code",
    defaultName: `claude-code-${nanoid(4)}`,
  });
  agentId = reg.agentId;
}

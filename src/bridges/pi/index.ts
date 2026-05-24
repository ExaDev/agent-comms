/**
 * Agent Comms — pi bridge extension.
 *
 * Provides the `agent_comms` tool and receives incoming messages
 * via TCP mesh push, forwarding them to the LLM via sendUserMessage().
 *
 * Install: add bridge path to ~/.pi/agent/settings.json extensions array
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";

import {
  MeshStore,
  CommsTool,
  buildAction,
  ensureRegistered,
  formatDeliveryEvent,
} from "../../core/index.js";
import {
  tryStartWebServer,
  type WebServerHandle,
} from "../user/web/server.js";
import { nanoid } from "../../core/nanoid.js";

/** Resolve the listening port from a running web server handle. */
function getWebPort(handle: WebServerHandle): number | undefined {
  const addr = handle.server.address();
  return typeof addr === "object" && addr ? addr.port : undefined;
}

/** Resolve the listening port from a running web server handle. */
function getWebPort(handle: WebServerHandle): number | undefined {
  const addr = handle.server.address();
  return typeof addr === "object" && addr ? addr.port : undefined;
}

export default function (pi: ExtensionAPI) {
  const store = new MeshStore();
  const tool = new CommsTool(store);

  let agentId: string | undefined;
  let webHandle: WebServerHandle | undefined;

  // Incoming messages arrive via TCP mesh — push immediately
  store.onDelivery = (_targetId: string, event) => {
    const line = formatDeliveryEvent(event);
    pi.sendUserMessage(`📬 ${line}`, { deliverAs: "steer" });
  };

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    await store.init();

    // Auto-start web UI on a dynamic port
    webHandle = await tryStartWebServer();

    const reg = await ensureRegistered({
      store,
      cwd: process.cwd(),
      harness: "pi",
      defaultName: `pi-${nanoid(4)}`,
    });
    agentId = reg.agentId;

    if (!reg.isNew) {
      ctx.ui.notify(`Agent Comms: resumed as ${reg.agentId}`, "info");
    }
  });

  pi.on("session_shutdown", async () => {
    // Shut down the web server before the bridge store so the web
    // controller's coordinator connection can close cleanly.
    if (webHandle) {
      webHandle.wss.close();
      webHandle.server.close();
      await webHandle.controller.shutdown();
      webHandle = undefined;
    }
    if (agentId) {
      await store.setAgentOffline(agentId);
    }
    await store.shutdown();
  });

  // -----------------------------------------------------------------------
  // Commands
  // -----------------------------------------------------------------------

  pi.registerCommand("comms-url", {
    description: "Show the Agent Comms web UI URL",
    handler: (_args, ctx) => {
      if (!webHandle) {
        ctx.ui.notify("Web UI is not running.", "error");
        return;
      }
      const port = getWebPort(webHandle);
      if (!port) {
        ctx.ui.notify("Web UI port not yet assigned.", "error");
        return;
      }
      ctx.ui.notify(`http://127.0.0.1:${String(port)}`, "info");
    },
  });

  // -----------------------------------------------------------------------
  // Commands
  // -----------------------------------------------------------------------

  pi.registerCommand("comms-url", {
    description: "Show the Agent Comms web UI URL",
    handler: async (_args, ctx) => {
      if (!webHandle) {
        ctx.ui.notify("Web UI is not running.", "error");
        return;
      }
      const port = getWebPort(webHandle);
      if (!port) {
        ctx.ui.notify("Web UI port not yet assigned.", "error");
        return;
      }
      ctx.ui.notify(`http://127.0.0.1:${String(port)}`, "info");
    },
  });

  // -----------------------------------------------------------------------
  // Commands
  // -----------------------------------------------------------------------

  pi.registerCommand("comms-url", {
    description: "Show the Agent Comms web UI URL",
    handler: (_args, ctx) => {
      if (!webHandle) {
        ctx.ui.notify("Web UI is not running.", "error");
        return;
      }
      const port = getWebPort(webHandle);
      if (!port) {
        ctx.ui.notify("Web UI port not yet assigned.", "error");
        return;
      }
      ctx.ui.notify(`http://127.0.0.1:${String(port)}`, "info");
    },
  });

  // -----------------------------------------------------------------------
  // Tool registration
  // -----------------------------------------------------------------------

  pi.registerTool({
    name: "agent_comms",
    label: "Agent Comms",
    description: [
      "Cross-harness agent communication mesh. Send messages to rooms and DM other agents.",
      "Actions: register, update, whoami, create_room, list_rooms, join_room, leave_room,",
      "send, dm, list_agents, read_room, invite, decline_invite, kick, destroy_room, web_url.",
      "Register first, then join or create rooms to communicate.",
    ].join(" "),
    promptSnippet: "Communicate with other LLM agents via rooms and DMs",
    promptGuidelines: [
      "Use agent_comms to coordinate with other running agents. Register on session start, join rooms for collaboration.",
    ],
    parameters: Type.Object({
      action: StringEnum(
        [
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
          "web_url",
        ],
        { description: "Action to perform" },
      ),
      name: Type.Optional(
        Type.String({
          description: "Agent display name (for register/update)",
        }),
      ),
      visibility: Type.Optional(
        StringEnum(["visible", "hidden", "ghost"], {
          description: "Visibility to other agents",
        }),
      ),
      tags: Type.Optional(
        Type.Array(Type.String(), { description: "Agent capability tags" }),
      ),
      status: Type.Optional(
        StringEnum(["active", "idle", "busy"], {
          description: "Agent status (for update)",
        }),
      ),
      room: Type.Optional(Type.String({ description: "Room name/ID" })),
      type: Type.Optional(
        StringEnum(["public", "private", "secret"], {
          description: "Room type (for create_room)",
        }),
      ),
      description: Type.Optional(
        Type.String({ description: "Room description (for create_room)" }),
      ),
      target: Type.Optional(
        Type.String({ description: "Target room name or agent ID" }),
      ),
      content: Type.Optional(Type.String({ description: "Message content" })),
      replyTo: Type.Optional(
        Type.String({ description: "Message ID to reply to" }),
      ),
      agent: Type.Optional(
        Type.String({ description: "Target agent ID (for invite/kick)" }),
      ),
      since: Type.Optional(
        Type.String({
          description: "ISO timestamp to read messages since",
        }),
      ),
      reason: Type.Optional(
        Type.String({
          description: "Reason for declining an invite (for decline_invite)",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (params.action === "web_url") {
        if (!webHandle) {
          return {
            content: [{ type: "text", text: "Web UI is not running." }],
            details: { action: "web_url" },
            isError: true,
          };
        }
        const port = getWebPort(webHandle);
        if (!port) {
          return {
            content: [{ type: "text", text: "Web UI port not yet assigned." }],
            details: { action: "web_url" },
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: `http://127.0.0.1:${String(port)}` }],
          details: { action: "web_url" },
          isError: false,
        };
      }

      if (!agentId) {
        return {
          content: [{ type: "text", text: "Error: not registered" }],
          details: {},
          isError: true,
        };
      }

      const action = buildAction(params);
      const result = await tool.handle(
        { agentId, harness: "pi", cwd: process.cwd(), pid: process.pid },
        action,
      );

      return {
        content: [{ type: "text", text: result.content }],
        details: { action: params.action },
        isError: result.isError,
      };
    },
  });
}

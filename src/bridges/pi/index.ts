/**
 * Agent Comms — pi bridge extension.
 *
 * Provides the `agent_comms` tool and receives incoming messages
 * via TCP mesh push. Actionable events (DMs, room messages, invites)
 * wake the model via sendMessage() with a custom type; informational
 * events are buffered and drained on the next tool call.
 *
 * Install: symlink into ~/.pi/agent/extensions/ with pi.extensions
 * pointing to this file.
 */

import type {
  ExtensionAPI,
  ExtensionUIContext,
} from "@mariozechner/pi-coding-agent";
import * as path from "node:path";
import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";

import {
  MeshStore,
  CommsTool,
  buildAction,
  ensureProjectRoom,
  ensureRegistered,
  formatDeliveryEvent,
  isActionableEvent,
} from "../../core/index.js";
import { TlsTransport } from "../../core/tls-transport.js";
import { generateIdentity } from "../../core/identity.js";
import { tryStartWebServer, type WebServerHandle } from "../user/web/server.js";
import { ChatController } from "../user/controller.js";
import { nanoid } from "../../core/nanoid.js";

/** Resolve the listening port from a running web server handle. */
function getWebPort(handle: WebServerHandle): number | undefined {
  const addr = handle.server.address();
  return typeof addr === "object" && addr ? addr.port : undefined;
}

export default function (pi: ExtensionAPI) {
  // Generate cryptographic identity and use TLS transport
  const identity = generateIdentity();
  const store = new MeshStore();
  store.peerId = identity.fingerprint;
  store.setTransport(new TlsTransport(store.events, identity));
  const tool = new CommsTool(store, store.discovery);

  let agentId: string | undefined;
  let webHandle: WebServerHandle | undefined;
  let uiCtx: ExtensionUIContext | undefined;
  let projectRoom: string | undefined;
  const informationalBuffer: string[] = [];

  // LRU-style dedup for delivery events
  const recentDeliveries = new Set<string>();
  const MAX_DEDUP_ENTRIES = 100;

  function refreshStatus(): void {
    if (!uiCtx) return;
    const parts: string[] = [];
    if (projectRoom) parts.push(`💬 ${projectRoom}`);
    if (webHandle) {
      const port = getWebPort(webHandle);
      if (port) parts.push(`http://127.0.0.1:${String(port)}`);
    }
    if (informationalBuffer.length > 0) {
      parts.push(`📬 ${String(informationalBuffer.length)}`);
    }
    uiCtx.setStatus("comms", parts.length > 0 ? parts.join("  ") : undefined);
  }

  store.onDelivery = (_targetId: string, event) => {
    const key = `${event.type}:${formatDeliveryEvent(event)}`;
    if (recentDeliveries.has(key)) return;
    recentDeliveries.add(key);
    if (recentDeliveries.size > MAX_DEDUP_ENTRIES) {
      // Evict oldest entries (simple approach: clear half)
      const entries = Array.from(recentDeliveries);
      const half = Math.floor(entries.length / 2);
      for (let i = 0; i < half; i++) {
        const entry = entries[i];
        if (entry !== undefined) recentDeliveries.delete(entry);
      }
    }

    const line = formatDeliveryEvent(event);

    if (isActionableEvent(event)) {
      // Actionable events wake the model via sendMessage (not sendUserMessage)
      pi.sendMessage(
        {
          content: `📬 ${line}`,
          customType: "comms-delivery",
          display: false,
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    } else {
      // Informational events buffer for next tool call
      informationalBuffer.push(line);
    }

    uiCtx?.notify(`📬 ${line}`, "info");
    refreshStatus();
  };

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  let meshReady = false;

  pi.on("session_start", async (_event, ctx) => {
    uiCtx = ctx.ui;

    try {
      await store.init();
      meshReady = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(
        `Agent Comms: mesh init failed (${msg}). Running without mesh.`,
        "warning",
      );
    }

    if (meshReady) {
      const reg = await ensureRegistered({
        store,
        cwd: process.cwd(),
        harness: "pi",
        defaultName: `pi-${nanoid(4)}`,
      });
      agentId = reg.agentId;

      // Auto-create and join a project room for the working directory
      await ensureProjectRoom(store, agentId, process.cwd());
      projectRoom = path.basename(process.cwd());

      // Start web UI sharing the same mesh peer and agent identity
      const webCtrl = ChatController.fromExisting(store, {
        agentId,
        harness: "pi",
        cwd: process.cwd(),
        pid: process.pid,
      });
      webHandle = await tryStartWebServer(webCtrl, store.coordinatorPort);
    }

    refreshStatus();

    if (meshReady) {
      ctx.ui.notify("Agent Comms: connected", "info");
    }
  });

  pi.on("session_shutdown", async () => {
    uiCtx?.setStatus("comms", undefined);
    uiCtx = undefined;
    // Shut down the web server before the bridge store so the web
    // controller's coordinator connection can close cleanly.
    if (webHandle) {
      webHandle.wss.close();
      webHandle.server.close();
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
    // eslint-disable-next-line @typescript-eslint/require-await -- SDK requires Promise<void> return
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

      // Drain buffered informational events and prepend to the response
      const pending = informationalBuffer.splice(0);
      refreshStatus();
      const prefix =
        pending.length > 0
          ? `[comms] Pending events:\n${pending.map((l: string) => `  📬 ${l}`).join("\n")}\n\n`
          : "";

      return {
        content: [{ type: "text", text: `${prefix}${result.content}` }],
        details: { action: params.action },
        isError: result.isError,
      };
    },
  });
}

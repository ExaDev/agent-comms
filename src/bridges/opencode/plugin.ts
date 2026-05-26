/**
 * Agent Comms — OpenCode plugin bridge.
 *
 * Receives incoming messages via TCP mesh push and injects them
 * into the OpenCode TUI via tui.prompt.append + tui.submitPrompt.
 *
 * Install (project):  ln -s ~/Developer/agent-comms/src/bridges/opencode/plugin.ts .opencode/plugins/agent-comms.ts
 * Install (global):   ln -s ~/Developer/agent-comms/src/bridges/opencode/plugin.ts ~/.config/opencode/plugins/agent-comms.ts
 */

import {
  MeshStore,
  ensureRegistered,
  formatDeliveryEvent,
} from "../../core/index.js";
import { TlsTransport } from "../../core/tls-transport.js";
import { generateIdentity } from "../../core/identity.js";
import { tryStartWebServer } from "../user/web/server.js";
import { nanoid } from "../../core/nanoid.js";

const identity = generateIdentity();
const store = new MeshStore();
store.peerId = identity.fingerprint;
store.setTransport(new TlsTransport(store.events, identity));

// Minimal interface for the OpenCode SDK client we actually use
interface OpenCodeClient {
  tui: {
    appendPrompt(body: { text: string }): Promise<unknown>;
    submitPrompt(): Promise<unknown>;
  };
  session: {
    list(): Promise<{ data: { id: string }[] }>;
    prompt(opts: {
      path: { id: string };
      body: { parts: { type: string; text: string }[] };
    }): Promise<unknown>;
  };
}

function isOpenCodeClient(value: unknown): value is OpenCodeClient {
  if (typeof value !== "object" || value === null) return false;
  if (!("tui" in value)) return false;
  if (!("session" in value)) return false;
  return true;
}

export const AgentCommsPlugin = async (opts: {
  project: unknown;
  client: unknown;
  $: unknown;
  directory: string;
  worktree: string;
}) => {
  if (!isOpenCodeClient(opts.client)) {
    throw new Error("Agent Comms plugin requires a valid OpenCode client");
  }
  const client = opts.client;

  await store.init();
  await tryStartWebServer();

  const reg = await ensureRegistered({
    cwd: process.cwd(),
    store,
    harness: "opencode",
    defaultName: `opencode-${nanoid(4)}`,
  });
  const agentId = reg.agentId;

  // Incoming messages arrive via TCP mesh — push to TUI immediately
  store.onDelivery = async (_targetId: string, event) => {
    const line = formatDeliveryEvent(event);
    const message = `📬 Agent Comms: ${line}`;
    try {
      await client.tui.appendPrompt({ text: message });
      await client.tui.submitPrompt();
    } catch {
      // Fallback: prompt the current session directly
      const sessions = await client.session.list();
      const current = sessions.data[0];
      if (current) {
        await client.session.prompt({
          path: { id: current.id },
          body: {
            parts: [{ type: "text", text: message }],
          },
        });
      }
    }
  };

  return {
    event: async ({ event }: { event: { type: string } }) => {
      if (event.type === "session.idle") {
        // Drain any remaining undelivered messages on idle
        const events = await store.drainDelivery(agentId);
        for (const e of events) {
          const line = formatDeliveryEvent(e);
          try {
            await client.tui.appendPrompt({ text: `📬 ${line}` });
            await client.tui.submitPrompt();
          } catch {
            /* best effort */
          }
        }
      }
    },
  };
};

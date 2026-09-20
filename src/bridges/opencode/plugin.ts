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
  createBridgeMesh,
  createMeshErrorReporter,
  ensureRegistered,
  formatDeliveryEvent,
  installShutdownSignalHandlers,
} from "../../core/index.js";
import type { IdentitySlot } from "../../core/identity-store.js";
import { releaseIdentityLock } from "../../core/identity-store.js";
import { wireDefaultCcPeerFront } from "../cc-peer/default-front.js";
import { tryStartWebServer } from "../user/web/server.js";
import { nanoid } from "../../core/nanoid.js";

// Persistent identity for this slot: a stable device-id means the agent ID survives restarts, so peers can keep targeting us. A plugin unload has no hook here, so an unload that is not a process exit still leaves a stale lock, which self-heals via the pid probe.
const identitySlot: IdentitySlot = { harness: "opencode", cwd: process.cwd() };

// Length (in characters) of the random suffix appended to the default auto-generated agent name.
const DEFAULT_NAME_SUFFIX_LENGTH = 4;

// Minimal interface for the OpenCode SDK client we actually use
interface OpenCodeClient {
  tui: {
    appendPrompt: (body: Readonly<{ text: string }>) => Promise<unknown>;
    submitPrompt: () => Promise<unknown>;
  };
  session: {
    list: () => Promise<{ data: { id: string }[] }>;
    prompt: (
      opts: Readonly<{
        path: { id: string };
        body: { parts: { type: string; text: string }[] };
      }>,
    ) => Promise<unknown>;
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

  const { store } = await createBridgeMesh(identitySlot);
  store.onError = createMeshErrorReporter();
  store.onCoordinatorRoleChanged = wireDefaultCcPeerFront(store);
  await store.init();
  await tryStartWebServer();

  const reg = await ensureRegistered({
    cwd: process.cwd(),
    store,
    harness: "opencode",
    defaultName: `opencode-${nanoid(DEFAULT_NAME_SUFFIX_LENGTH)}`,
  });
  const agentId = reg.agentId;

  // "reraise", not "exit": this plugin runs inside OpenCode's own process, and registering a signal listener at all removes Node's default terminate behaviour, so exiting here would pre-empt the host and doing nothing would swallow its Ctrl-C.
  installShutdownSignalHandlers({
    shutdown: async () => {
      await store.setAgentOffline(agentId);
      await store.shutdown();
      releaseIdentityLock(identitySlot);
    },
    disposition: "reraise",
    onError: createMeshErrorReporter(),
  });

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

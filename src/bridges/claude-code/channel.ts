/**
 * Agent Comms — Claude Code channel bridge.
 *
 * MCP channel server that provides the "agent_comms" tool and pushes
 * incoming messages into Claude's context via <channel> events and hooks.
 * Uses TCP mesh for real-time delivery — no filesystem polling.
 *
 * Run via: npx agent-comms bridge claude-code
 *
 * Pending events are persisted to ~/.agents/bus/pending/claude-code--<slug>.jsonl
 * so the asyncRewake hook scripts (hooks/drain.sh) can drain them out-of-process
 * and wake idle Claude via exit code 2.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  MeshStore,
  CommsTool,
  buildAction,
  ensureRegistered,
  extractStreamingBehavior,
  formatDeliveryEvent,
  isActionableEvent,
  MCP_TOOL_PARAMS,
} from "../../core/index.js";
import { TlsTransport } from "../../core/tls-transport.js";
import { generateIdentity } from "../../core/identity.js";
import { tryStartWebServer } from "../user/web/server.js";
import { nanoid } from "../../core/nanoid.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === "object" && err !== null && "code" in err;
}

function cwdSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "_");
}

function pendingDir(): string {
  return path.join(os.homedir(), ".agents", "bus", "pending");
}

/**
 * Walk up the process tree to find the Claude Code CLI PID.
 *
 * The bridge runs ~3 hops below claude (tsx wrapper → tsx loader → bridge),
 * so process.ppid alone isn't enough. We walk until we find an ancestor
 * whose command basename is "claude".
 *
 * Two Claude Code instances in the same cwd would otherwise share one
 * pending file and consume each other's messages. Keying by Claude PID
 * isolates them. Returns undefined if no claude ancestor can be located
 * within 10 hops — caller falls back to cwd-only path.
 */
function findClaudeCodePid(): number | undefined {
  let pid = process.ppid;
  for (let i = 0; i < 10 && pid > 1; i++) {
    let out: string;
    try {
      out = execFileSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], {
        encoding: "utf-8",
      });
    } catch {
      return undefined;
    }
    const trimmed = out.trim();
    const match = /^(\d+)\s+(.+)$/.exec(trimmed);
    if (!match) return undefined;
    const parentPid = Number.parseInt(match[1] ?? "", 10);
    const comm = (match[2] ?? "").trim();
    if (/(^|\/)claude$/.test(comm)) return pid;
    if (!Number.isFinite(parentPid)) return undefined;
    pid = parentPid;
  }
  return undefined;
}

function pendingFilePath(cwd: string, claudePid: number | undefined): string {
  const slug = cwdSlug(cwd);
  const name =
    claudePid !== undefined
      ? `claude-code--${slug}--${String(claudePid)}.jsonl`
      : `claude-code--${slug}.jsonl`;
  return path.join(pendingDir(), name);
}

/**
 * Drop pending files in this cwd whose owning Claude Code PID is no longer
 * alive. Prevents accumulation when sessions exit without graceful shutdown.
 */
function cleanupStalePendingFiles(cwd: string): void {
  const dir = pendingDir();
  const slug = cwdSlug(cwd);
  const prefix = `claude-code--${slug}--`;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") return;
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith(".jsonl")) continue;
    const pidStr = entry.slice(prefix.length, -".jsonl".length);
    const pid = Number.parseInt(pidStr, 10);
    if (!Number.isFinite(pid) || pid <= 1) continue;
    try {
      process.kill(pid, 0);
    } catch (err) {
      if (isErrnoException(err) && err.code === "ESRCH") {
        try {
          fs.unlinkSync(path.join(dir, entry));
        } catch {
          // best-effort cleanup, ignore failures
        }
      }
    }
  }
}

function appendPending(filePath: string, line: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, line + "\n");
}

function drainPending(filePath: string): string[] {
  const drainPath = `${filePath}.draining-${String(process.pid)}-${String(Date.now())}`;
  try {
    fs.renameSync(filePath, drainPath);
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") return [];
    throw err;
  }
  const content = fs.readFileSync(drainPath, "utf-8");
  fs.unlinkSync(drainPath);
  return content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export async function run(): Promise<void> {
  const identity = generateIdentity();
  const store = new MeshStore();
  store.peerId = identity.fingerprint;
  store.setTransport(new TlsTransport(store.events, identity));
  const tool = new CommsTool(store, store.discovery);
  let agentId: string | undefined;

  const claudeCodePid = findClaudeCodePid();
  if (claudeCodePid === undefined) {
    process.stderr.write(
      "agent-comms bridge: could not locate Claude Code PID; using shared cwd pending file (concurrent sessions in the same cwd will share messages)\n",
    );
  }
  cleanupStalePendingFiles(process.cwd());
  const pendingFile = pendingFilePath(process.cwd(), claudeCodePid);

  const mcp = new McpServer(
    { name: "agent-comms", version: "0.2.0" },
    {
      capabilities: {
        experimental: { "claude/channel": {} },
      },
    },
  );

  // All events are written to the pending file so the out-of-process hook
  // drain script can surface them to idle Claude via asyncRewake exit 2.
  // Actionable events also get an eager channel push for mid-turn delivery
  // when channels are enabled (--dangerously-load-development-channels).
  store.onDelivery = async (_targetId: string, event) => {
    const line = formatDeliveryEvent(event);
    const hint = extractStreamingBehavior(event);
    const shouldPush = isActionableEvent(event) && hint !== "info";

    appendPending(pendingFile, line);

    if (shouldPush) {
      await mcp.server.notification({
        method: "notifications/claude/channel",
        params: {
          content: line,
          meta: { streamingBehavior: hint ?? "steer" },
        },
      });
    }
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
        'Incoming messages appear as <channel source="agent-comms"> events or [comms] Pending prefix.',
        "Use streamingBehavior on send/dm: steer (act now), followUp (act when idle), info (whenever, default).",
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

      const pending = drainPending(pendingFile);
      const prefix =
        pending.length > 0
          ? `[comms] Pending:\n${pending.map((l) => `  📬 ${l}`).join("\n")}\n\n`
          : "";

      return {
        content: [{ type: "text", text: `${prefix}${result.content}` }],
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

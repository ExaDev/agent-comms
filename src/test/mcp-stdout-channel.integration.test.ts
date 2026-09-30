/**
 * stdout is the MCP channel (agent-comms#348): with stdin piped, the bridge must write nothing to it that is not a JSON-RPC message, or a strictly framed client rejects the stream. Diagnostics, including the web UI banner, belong on stderr.
 */

import { afterEach, expect, it } from "vitest";
import * as child_process from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  freeLocalPort,
  TeardownStack,
  unreachableHubUrl,
} from "./hub-helpers.js";

const cleanups = new TeardownStack();

afterEach(async () => {
  await cleanups.run();
});

const RUNNER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "mcp-bridge.runner.ts",
);

const INITIALIZE_ID = 1;
const TOOLS_LIST_ID = 2;
const MCP_PROTOCOL_VERSION = "2025-06-18";

/** Startup includes a real store init and web server start in a fresh process, so the wait is generous; the test's own timeout is the backstop. */
const RESPONSE_TIMEOUT_MS = 25_000;

function jsonRpcLine(message: Record<string, unknown>): string {
  return `${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`;
}

function isJsonRpcMessage(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "jsonrpc" in value &&
    value.jsonrpc === "2.0"
  );
}

it("writes only JSON-RPC messages to stdout and puts the web UI banner on stderr", async () => {
  const slotDir = fs.mkdtempSync(path.join(tmpdir(), "agent-comms-mcp-test-"));
  cleanups.push(async () => {
    fs.rmSync(slotDir, { recursive: true, force: true });
  });
  const child = child_process.spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      RUNNER,
      JSON.stringify({
        coordinatorPort: await freeLocalPort(),
        firstContactPort: await freeLocalPort(),
        hubUrl: await unreachableHubUrl(),
        slotDir,
      }),
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => {
      resolve();
    });
  });
  cleanups.push(async () => {
    child.kill("SIGTERM");
    await exited;
  });

  const stdoutLines: string[] = [];
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const answered = new Set<number>();
  const bothAnswered = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `no JSON-RPC responses within the timeout; stdout=${JSON.stringify(stdoutLines)} stderr=${stderr}`,
        ),
      );
    }, RESPONSE_TIMEOUT_MS);
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      stdoutLines.push(line);
      try {
        const parsed: unknown = JSON.parse(line);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "id" in parsed &&
          typeof parsed.id === "number"
        ) {
          answered.add(parsed.id);
        }
      } catch {
        // A non-JSON line is recorded above and fails the assertion below; the wait then ends at the timeout or the next response.
      }
      if (answered.has(INITIALIZE_ID) && answered.has(TOOLS_LIST_ID)) {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  child.stdin.write(
    jsonRpcLine({
      id: INITIALIZE_ID,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "stdout-channel-test", version: "0.0.0" },
      },
    }),
  );
  child.stdin.write(jsonRpcLine({ method: "notifications/initialized" }));
  child.stdin.write(jsonRpcLine({ id: TOOLS_LIST_ID, method: "tools/list" }));
  await bothAnswered;

  expect(stdoutLines.length).toBeGreaterThanOrEqual(2);
  for (const line of stdoutLines) {
    expect(isJsonRpcMessage(JSON.parse(line))).toBe(true);
  }
  expect(stderr).toContain("Agent Comms web UI: http://127.0.0.1:");
});

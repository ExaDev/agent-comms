/**
 * Unit tests proving createBridgeMesh wires a VersionDriftChecker into the CommsTool it builds (agent-comms#166) -- every real bridge (pi, claude-code, codex, mcp, opencode, cc-peer) constructs its store/tool through this one factory, so this is the single place that needs to prove the wiring works rather than duplicating the assertion per bridge.
 *
 * fetchLatestVersion is injected in every test here specifically so this file never makes a real network call to the npm registry -- see bridge-mesh.ts's own header on why that parameter exists.
 */

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect } from "vitest";
import { createBridgeMesh } from "../core/bridge-mesh.js";
import { getOwnPackageVersion } from "../core/package-version.js";
import { buildAction } from "../core/bridge.js";
import type { IdentitySlot } from "../core/identity-store.js";
import type { CommsTool } from "../core/tool.js";

function tempSlot(harness: string): IdentitySlot {
  const dir = fs.mkdtempSync(
    path.join(tmpdir(), "agent-comms-bridge-mesh-version-drift-test-"),
  );
  return { harness, cwd: "/tmp/project", dir };
}

// Never rely on the default coordinator port (19876) in a test -- this machine routinely runs other, real agent-comms bridges (this very session's own MCP tool included) that are genuinely listening there, and a solo test store becoming a peer of that unrelated live mesh rather than its own coordinator hangs indefinitely on the first round trip that expects a same-test peer to answer. Matches the ephemeral port range bridge-mesh.test.ts's own multi-peer test already uses for the identical reason.
const TEST_COORDINATOR_PORT_BASE = 21_100;
const TEST_COORDINATOR_PORT_RANGE = 100;

function testCoordinatorPort(): number {
  return (
    TEST_COORDINATOR_PORT_BASE +
    Math.floor(Math.random() * TEST_COORDINATOR_PORT_RANGE)
  );
}

const POLL_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 20;

/**
 * Re-runs whoami until its content includes match or timeoutMs elapses -- VersionDriftChecker's own start() check is fire-and-forget (see version-check.ts), so there's no signal other than tool.handle's own output for when the checker's first check has actually landed.
 */
async function whoamiUntilContains(
  tool: CommsTool,
  ctx: Readonly<{ agentId: string; harness: string; cwd: string; pid: number }>,
  match: string,
): Promise<string> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const result = await tool.handle(ctx, buildAction({ action: "whoami" }));
    if (result.content.includes(match)) return result.content;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${String(POLL_TIMEOUT_MS)}ms waiting for whoami output to include "${match}". Last content:\n${result.content}`,
      );
    }
    await new Promise((resolve) => {
      setTimeout(resolve, POLL_INTERVAL_MS);
    });
  }
}

test("createBridgeMesh's tool reports an available update when the injected version checker finds a newer release", async () => {
  const slot = tempSlot("test-harness-drift");
  const newerVersion = "9999.0.0";
  const { store, tool } = await createBridgeMesh(slot, {
    coordinatorPort: testCoordinatorPort(),
    fetchLatestVersion: async () => Promise.resolve(newerVersion),
  });
  try {
    await store.init();
    const agent = await store.registerAgent({
      name: "drift-test-agent",
      harness: "test-harness-drift",
      cwd: "/tmp/project",
      pid: process.pid,
      visibility: "visible",
      tags: [],
    });
    const ctx = {
      agentId: agent.id,
      harness: "test-harness-drift",
      cwd: "/tmp/project",
      pid: process.pid,
    };

    const content = await whoamiUntilContains(tool, ctx, "Update available");

    expect(content).toContain(`Version: ${getOwnPackageVersion()}`);
    expect(content).toContain(`Update available: ${newerVersion}`);
  } finally {
    await store.shutdown();
  }
});

test("createBridgeMesh's tool reports its own version with no update line when no newer release is known", async () => {
  const slot = tempSlot("test-harness-no-drift");
  const { store, tool } = await createBridgeMesh(slot, {
    coordinatorPort: testCoordinatorPort(),
    fetchLatestVersion: async () => Promise.resolve(undefined),
  });
  try {
    await store.init();
    const agent = await store.registerAgent({
      name: "no-drift-test-agent",
      harness: "test-harness-no-drift",
      cwd: "/tmp/project",
      pid: process.pid,
      visibility: "visible",
      tags: [],
    });
    const ctx = {
      agentId: agent.id,
      harness: "test-harness-no-drift",
      cwd: "/tmp/project",
      pid: process.pid,
    };

    const result = await tool.handle(ctx, buildAction({ action: "whoami" }));

    expect(result.content).toContain(`Version: ${getOwnPackageVersion()}`);
    expect(result.content).not.toContain("Update available");
  } finally {
    await store.shutdown();
  }
});

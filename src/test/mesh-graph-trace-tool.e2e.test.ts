/**
 * CommsTool's mesh_graph/mesh_trace actions (agent-comms#199) -- the tool-layer dispatch/formatting on top of MeshStore.meshGraph/meshTrace, mirroring web-url-tool-action.test.ts's own real-MeshStore-plus-CommsTool pattern. The underlying wire-level behaviour (real gossip-derived topology/peers, a real path.trace round trip, direct vs hub-relayed routing) is already proven end-to-end against WireMeshTransport directly in mesh-graph-trace.integration.test.ts; this file covers what's unique to the tool layer: notMeshBacked, empty-graph/unreachable-device formatting, and buildAction parsing.
 */
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, describe, expect } from "vitest";
import { MeshStore } from "../core/mesh-store.js";
import { CommsTool } from "../core/tool.js";
import { buildAction } from "../core/bridge.js";
import { FileStore } from "../core/store.js";
import { wireTestTransport } from "./test-transport.js";

/** A device-id is SHA-256(public key) -- 32 raw bytes, 64 hex characters. */
const DEVICE_ID_BYTE_LENGTH = 32;
/** Arbitrary, distinctive mesh_trace timeoutMs override for buildAction parsing tests. */
const TEST_TIMEOUT_MS = 5000;

function tempFileStore(): FileStore {
  const root = fs.mkdtempSync(
    path.join(tmpdir(), "agent-comms-mesh-graph-trace-tool-"),
  );
  return new FileStore(root);
}

async function registeredContext(
  store: MeshStore,
): Promise<{ agentId: string; harness: string; cwd: string; pid: number }> {
  const agent = await store.registerAgent({
    name: "mesh-graph-trace-tool-test",
    harness: "test",
    cwd: "/test",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  return {
    agentId: agent.id,
    harness: "test",
    cwd: "/test",
    pid: process.pid,
  };
}

describe("CommsTool mesh_graph action", () => {
  test("reports not mesh-backed on a FileStore", async () => {
    const store = tempFileStore();
    const tool = new CommsTool(store);

    const result = await tool.handle(
      { agentId: "a", harness: "test", cwd: "/test", pid: process.pid },
      buildAction({ action: "mesh_graph" }),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("mesh-backed store");
  });

  test("reports an empty graph before any gossip has been received", async () => {
    const store = new MeshStore();
    await wireTestTransport(store);
    const ctx = await registeredContext(store);
    const tool = new CommsTool(store);

    const result = await tool.handle(
      ctx,
      buildAction({ action: "mesh_graph" }),
    );

    expect(result.isError, result.content).toBe(false);
    expect(result.content).toBe("No known devices in the mesh graph.");

    await store.shutdown();
  });
});

describe("CommsTool mesh_trace action", () => {
  test("reports not mesh-backed on a FileStore", async () => {
    const store = tempFileStore();
    const tool = new CommsTool(store);

    const result = await tool.handle(
      { agentId: "a", harness: "test", cwd: "/test", pid: process.pid },
      buildAction({ action: "mesh_trace", target: "aabbcc" }),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("mesh-backed store");
  });

  test("reports a not_connected error for an unreachable device", async () => {
    const store = new MeshStore();
    await wireTestTransport(store);
    const ctx = await registeredContext(store);
    const tool = new CommsTool(store);
    const unknownDeviceHex = "ab".repeat(DEVICE_ID_BYTE_LENGTH);

    const result = await tool.handle(
      ctx,
      buildAction({ action: "mesh_trace", target: unknownDeviceHex }),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("not_connected");

    await store.shutdown();
  });
});

describe("buildAction mesh_graph/mesh_trace parsing", () => {
  test("buildAction parses mesh_graph", () => {
    const action = buildAction({ action: "mesh_graph" });
    expect(action.action).toBe("mesh_graph");
  });

  test("buildAction parses mesh_trace with target and timeoutMs", () => {
    const action = buildAction({
      action: "mesh_trace",
      target: "aabbcc",
      timeoutMs: TEST_TIMEOUT_MS,
    });
    expect(action.action).toBe("mesh_trace");
    if (action.action === "mesh_trace") {
      expect(action.target).toBe("aabbcc");
      expect(action.timeoutMs).toBe(TEST_TIMEOUT_MS);
    }
  });

  test("buildAction omits timeoutMs for mesh_trace when not given", () => {
    const action = buildAction({ action: "mesh_trace", target: "aabbcc" });
    expect(action.action).toBe("mesh_trace");
    if (action.action === "mesh_trace") {
      expect(action.timeoutMs).toBeUndefined();
    }
  });

  test("buildAction throws for mesh_trace without target", () => {
    expect(() => buildAction({ action: "mesh_trace" })).toThrow(/target/);
  });
});

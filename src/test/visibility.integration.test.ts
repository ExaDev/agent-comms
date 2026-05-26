/**
 * Integration tests for mesh visibility controls.
 *
 * Verifies that the DiscoveryManager visibility state machine works:
 *   - Default visibility is discoverable
 *   - Setting to quiet pauses advertising
 *   - Setting to dark stops all discovery
 *   - Per-adapter visibility overrides global
 *   - Actions route through CommsTool correctly
 */

import * as assert from "node:assert/strict";
import { test, describe } from "node:test";
import { MeshStore } from "../core/mesh-store.js";
import { CommsTool } from "../core/tool.js";
import { buildAction } from "../core/bridge.js";
import { DiscoveryManager } from "../core/discovery.js";
import type { MeshVisibility } from "../core/types.js";

const TEST_PORT = 19881;

// ---------------------------------------------------------------------------
// DiscoveryManager unit tests (no mesh init)
// ---------------------------------------------------------------------------

describe("DiscoveryManager visibility", () => {
  void test("default visibility is discoverable", () => {
    const dm = new DiscoveryManager();
    assert.equal(dm.getVisibility(), "discoverable");
  });

  void test("setVisibility changes global visibility", async () => {
    const dm = new DiscoveryManager();
    await dm.setVisibility("quiet");
    assert.equal(dm.getVisibility(), "quiet");
    await dm.setVisibility("dark");
    assert.equal(dm.getVisibility(), "dark");
    await dm.setVisibility("discoverable");
    assert.equal(dm.getVisibility(), "discoverable");
  });

  void test("per-adapter visibility overrides global", async () => {
    const dm = new DiscoveryManager();
    await dm.setVisibility("quiet", "mdns");
    assert.equal(dm.getVisibility("mdns"), "quiet");
    // Global unchanged
    assert.equal(dm.getVisibility(), "discoverable");
    // Unset adapter falls back to global
    assert.equal(dm.getVisibility("tailscale"), "discoverable");
  });

  void test("per-adapter visibility is independent", async () => {
    const dm = new DiscoveryManager();
    await dm.setVisibility("quiet", "mdns");
    await dm.setVisibility("dark", "tailscale");
    assert.equal(dm.getVisibility("mdns"), "quiet");
    assert.equal(dm.getVisibility("tailscale"), "dark");
    assert.equal(dm.getVisibility(), "discoverable");
  });

  void test("discover returns empty for dark backends", async () => {
    const dm = new DiscoveryManager();
    await dm.setVisibility("dark");
    const results = await dm.discover();
    assert.equal(results.length, 0);
  });
});

// ---------------------------------------------------------------------------
// MeshStore delegation
// ---------------------------------------------------------------------------

describe("MeshStore visibility delegation", () => {
  void test("setVisibility delegates to discovery manager", async () => {
    const store = new MeshStore(TEST_PORT);
    await store.init();

    assert.equal(store.getVisibility(), "discoverable");

    await store.setVisibility("quiet");
    assert.equal(store.getVisibility(), "quiet");

    await store.setVisibility("dark");
    assert.equal(store.getVisibility(), "dark");

    await store.setVisibility("discoverable");
    assert.equal(store.getVisibility(), "discoverable");

    await store.shutdown();
  });

  void test("setVisibility with adapter delegates per-adapter", async () => {
    const store = new MeshStore(TEST_PORT);
    await store.init();

    await store.setVisibility("quiet", "mdns");
    assert.equal(store.getVisibility("mdns"), "quiet");
    assert.equal(store.getVisibility(), "discoverable");

    await store.shutdown();
  });
});

// ---------------------------------------------------------------------------
// CommsTool actions
// ---------------------------------------------------------------------------

describe("CommsTool visibility actions", () => {
  void test("mesh_set_visibility action sets visibility", async () => {
    const store = new MeshStore(TEST_PORT);
    await store.init();

    const agent = await store.registerAgent({
      name: "visibility-test",
      harness: "test",
      cwd: "/test",
      pid: process.pid,
      visibility: "visible",
      tags: [],
    });

    const tool = new CommsTool(store);

    const result = await tool.handle(
      { agentId: agent.id, harness: "test", cwd: "/test", pid: process.pid },
      { action: "mesh_set_visibility", visibility: "quiet" },
    );
    assert.ok(!result.isError, `Expected success, got: ${result.content}`);
    assert.ok(result.content.includes("quiet"));
    assert.equal(store.getVisibility(), "quiet");

    await store.shutdown();
  });

  void test("mesh_set_visibility with adapter sets per-adapter", async () => {
    const store = new MeshStore(TEST_PORT);
    await store.init();

    const agent = await store.registerAgent({
      name: "visibility-test",
      harness: "test",
      cwd: "/test",
      pid: process.pid,
      visibility: "visible",
      tags: [],
    });

    const tool = new CommsTool(store);

    const result = await tool.handle(
      { agentId: agent.id, harness: "test", cwd: "/test", pid: process.pid },
      { action: "mesh_set_visibility", visibility: "dark", adapter: "mdns" },
    );
    assert.ok(!result.isError, `Expected success, got: ${result.content}`);
    assert.equal(store.getVisibility("mdns"), "dark");
    assert.equal(store.getVisibility(), "discoverable");

    await store.shutdown();
  });

  void test("mesh_get_visibility returns current visibility", async () => {
    const store = new MeshStore(TEST_PORT);
    await store.init();

    const agent = await store.registerAgent({
      name: "visibility-test",
      harness: "test",
      cwd: "/test",
      pid: process.pid,
      visibility: "visible",
      tags: [],
    });

    const tool = new CommsTool(store);

    const result = await tool.handle(
      { agentId: agent.id, harness: "test", cwd: "/test", pid: process.pid },
      { action: "mesh_get_visibility" },
    );
    assert.ok(!result.isError);
    assert.ok(result.content.includes("discoverable"));

    await store.setVisibility("dark");

    const result2 = await tool.handle(
      { agentId: agent.id, harness: "test", cwd: "/test", pid: process.pid },
      { action: "mesh_get_visibility" },
    );
    assert.ok(result2.content.includes("dark"));

    await store.shutdown();
  });
});

// ---------------------------------------------------------------------------
// buildAction parsing
// ---------------------------------------------------------------------------

describe("buildAction visibility parsing", () => {
  void test("buildAction parses mesh_set_visibility", () => {
    const action = buildAction({
      action: "mesh_set_visibility",
      meshVisibility: "quiet",
    });
    assert.equal(action.action, "mesh_set_visibility");
    if (action.action === "mesh_set_visibility") {
      assert.equal(action.visibility, "quiet");
    }
  });

  void test("buildAction parses mesh_set_visibility with adapter", () => {
    const action = buildAction({
      action: "mesh_set_visibility",
      meshVisibility: "dark",
      adapter: "mdns",
    });
    assert.equal(action.action, "mesh_set_visibility");
    if (action.action === "mesh_set_visibility") {
      assert.equal(action.visibility, "dark");
      assert.equal(action.adapter, "mdns");
    }
  });

  void test("buildAction parses mesh_get_visibility", () => {
    const action = buildAction({
      action: "mesh_get_visibility",
    });
    assert.equal(action.action, "mesh_get_visibility");
  });

  void test("buildAction throws for mesh_set_visibility without meshVisibility", () => {
    assert.throws(
      () => buildAction({ action: "mesh_set_visibility" }),
      /meshVisibility/,
    );
  });
});

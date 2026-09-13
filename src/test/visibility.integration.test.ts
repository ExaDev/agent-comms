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

import { test, describe, expect } from "vitest";
import { MeshStore } from "../core/mesh-store.js";
import { CommsTool } from "../core/tool.js";
import { buildAction } from "../core/bridge.js";
import { DiscoveryManager } from "../core/discovery.js";
import type { MeshVisibility } from "../core/types.js";
import { wireTestTransport } from "./test-transport.js";

const TEST_PORT = 19881;

// ---------------------------------------------------------------------------
// DiscoveryManager unit tests (no mesh init)
// ---------------------------------------------------------------------------

describe("DiscoveryManager visibility", () => {
  test("default visibility is discoverable", () => {
    const dm = new DiscoveryManager();
    expect(dm.getVisibility()).toBe("discoverable");
  });

  test("setVisibility changes global visibility", async () => {
    const dm = new DiscoveryManager();
    await dm.setVisibility("quiet");
    expect(dm.getVisibility()).toBe("quiet");
    await dm.setVisibility("dark");
    expect(dm.getVisibility()).toBe("dark");
    await dm.setVisibility("discoverable");
    expect(dm.getVisibility()).toBe("discoverable");
  });

  test("per-adapter visibility overrides global", async () => {
    const dm = new DiscoveryManager();
    await dm.setVisibility("quiet", "mdns");
    expect(dm.getVisibility("mdns")).toBe("quiet");
    // Global unchanged
    expect(dm.getVisibility()).toBe("discoverable");
    // Unset adapter falls back to global
    expect(dm.getVisibility("tailscale")).toBe("discoverable");
  });

  test("per-adapter visibility is independent", async () => {
    const dm = new DiscoveryManager();
    await dm.setVisibility("quiet", "mdns");
    await dm.setVisibility("dark", "tailscale");
    expect(dm.getVisibility("mdns")).toBe("quiet");
    expect(dm.getVisibility("tailscale")).toBe("dark");
    expect(dm.getVisibility()).toBe("discoverable");
  });

  test("discover returns empty for dark backends", async () => {
    const dm = new DiscoveryManager();
    await dm.setVisibility("dark");
    const results = await dm.discover();
    expect(results.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// MeshStore delegation
// ---------------------------------------------------------------------------

describe("MeshStore visibility delegation", () => {
  test("setVisibility delegates to discovery manager", async () => {
    const store = new MeshStore(TEST_PORT);
    await wireTestTransport(store);
    await store.init();

    expect(store.getVisibility()).toBe("discoverable");

    await store.setVisibility("quiet");
    expect(store.getVisibility()).toBe("quiet");

    await store.setVisibility("dark");
    expect(store.getVisibility()).toBe("dark");

    await store.setVisibility("discoverable");
    expect(store.getVisibility()).toBe("discoverable");

    await store.shutdown();
  });

  test("setVisibility with adapter delegates per-adapter", async () => {
    const store = new MeshStore(TEST_PORT);
    await wireTestTransport(store);
    await store.init();

    await store.setVisibility("quiet", "mdns");
    expect(store.getVisibility("mdns")).toBe("quiet");
    expect(store.getVisibility()).toBe("discoverable");

    await store.shutdown();
  });
});

// ---------------------------------------------------------------------------
// CommsTool actions
// ---------------------------------------------------------------------------

describe("CommsTool visibility actions", () => {
  test("mesh_set_visibility action sets visibility", async () => {
    const store = new MeshStore(TEST_PORT);
    await wireTestTransport(store);
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
    expect(
      !result.isError,
      `Expected success, got: ${result.content}`,
    ).toBeTruthy();
    expect(result.content.includes("quiet")).toBeTruthy();
    expect(store.getVisibility()).toBe("quiet");

    await store.shutdown();
  });

  test("mesh_set_visibility with adapter sets per-adapter", async () => {
    const store = new MeshStore(TEST_PORT);
    await wireTestTransport(store);
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
    expect(
      !result.isError,
      `Expected success, got: ${result.content}`,
    ).toBeTruthy();
    expect(store.getVisibility("mdns")).toBe("dark");
    expect(store.getVisibility()).toBe("discoverable");

    await store.shutdown();
  });

  test("mesh_get_visibility returns current visibility", async () => {
    const store = new MeshStore(TEST_PORT);
    await wireTestTransport(store);
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
    expect(!result.isError).toBeTruthy();
    expect(result.content.includes("discoverable")).toBeTruthy();

    await store.setVisibility("dark");

    const result2 = await tool.handle(
      { agentId: agent.id, harness: "test", cwd: "/test", pid: process.pid },
      { action: "mesh_get_visibility" },
    );
    expect(result2.content.includes("dark")).toBeTruthy();

    await store.shutdown();
  });
});

// ---------------------------------------------------------------------------
// buildAction parsing
// ---------------------------------------------------------------------------

describe("buildAction visibility parsing", () => {
  test("buildAction parses mesh_set_visibility", () => {
    const action = buildAction({
      action: "mesh_set_visibility",
      meshVisibility: "quiet",
    });
    expect(action.action).toBe("mesh_set_visibility");
    if (action.action === "mesh_set_visibility") {
      expect(action.visibility).toBe("quiet");
    }
  });

  test("buildAction parses mesh_set_visibility with adapter", () => {
    const action = buildAction({
      action: "mesh_set_visibility",
      meshVisibility: "dark",
      adapter: "mdns",
    });
    expect(action.action).toBe("mesh_set_visibility");
    if (action.action === "mesh_set_visibility") {
      expect(action.visibility).toBe("dark");
      expect(action.adapter).toBe("mdns");
    }
  });

  test("buildAction parses mesh_get_visibility", () => {
    const action = buildAction({
      action: "mesh_get_visibility",
    });
    expect(action.action).toBe("mesh_get_visibility");
  });

  test("buildAction throws for mesh_set_visibility without meshVisibility", () => {
    expect(() => buildAction({ action: "mesh_set_visibility" })).toThrow(
      /meshVisibility/,
    );
  });
});

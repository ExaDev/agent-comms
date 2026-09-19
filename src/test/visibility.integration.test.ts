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

import { test, describe, expect, vi } from "vitest";
import { MeshStore } from "../core/mesh-store.js";
import { CommsTool } from "../core/tool.js";
import { buildAction } from "../core/bridge.js";
import { DiscoveryManager } from "../core/discovery.js";
import type { DiscoveryBackend, AdvertiseOptions } from "../core/discovery.js";
import type { MeshVisibility } from "../core/types.js";
import { wireTestTransport } from "./test-transport.js";

/** A fake DiscoveryBackend whose startAdvertising returns a NEW, incrementing id every call -- deliberately unlike the real mdns/tailscale backends' own deterministic `${name}-${port}` ids, so a test exercising it proves DiscoveryManager itself preserves a stable external advertisement id across pause/resume, rather than merely benefiting from a backend's own incidental determinism. */
function fakeBackend(name: string): DiscoveryBackend & {
  startCalls: AdvertiseOptions[];
  stopCalls: string[];
} {
  let counter = 0;
  const startCalls: AdvertiseOptions[] = [];
  const stopCalls: string[] = [];
  return {
    name,
    startCalls,
    stopCalls,
    startAdvertising: vi.fn(async (opts: Readonly<AdvertiseOptions>) => {
      await Promise.resolve();
      startCalls.push({ ...opts });
      counter += 1;
      return `${name}-internal-${String(counter)}`;
    }),
    stopAdvertising: vi.fn(async (id: string) => {
      await Promise.resolve();
      stopCalls.push(id);
    }),
    discover: vi.fn(async () => Promise.resolve([])),
    stop: vi.fn(async () => Promise.resolve()),
  };
}

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
// Pause/resume actually re-advertises (regression coverage for the bug the wire-mesh migration plan names: "quiet -> discoverable silently leaves you unadvertised" -- pauseAllAdvertisements/resumeAllAdvertisements used to discard the original AdvertiseOptions and never call backend.startAdvertising again on resume).
// ---------------------------------------------------------------------------

describe("DiscoveryManager pause/resume genuinely re-advertises", () => {
  test("setVisibility(quiet) then setVisibility(discoverable) calls startAdvertising again with the original opts", async () => {
    const dm = new DiscoveryManager();
    const backend = fakeBackend("mdns");
    dm.registerBackend(backend);
    const opts: AdvertiseOptions = { name: "my-mesh", port: 19876 };

    const id = await dm.advertise("mdns", opts);
    expect(backend.startCalls).toHaveLength(1);

    await dm.setVisibility("quiet");
    expect(backend.stopCalls).toContain("mdns-internal-1");
    expect(dm.isPaused(id)).toBe(true);

    await dm.setVisibility("discoverable");

    expect(backend.startCalls).toHaveLength(2);
    expect(backend.startCalls[1]).toEqual(opts);
    expect(dm.isPaused(id)).toBe(false);
  });

  test("the external advertisement id stays stable across a pause/resume cycle, even though the backend returns a new internal id each call", async () => {
    const dm = new DiscoveryManager();
    const backend = fakeBackend("mdns");
    dm.registerBackend(backend);
    const opts: AdvertiseOptions = { name: "my-mesh", port: 19876 };

    const id = await dm.advertise("mdns", opts);
    await dm.setVisibility("quiet");
    await dm.setVisibility("discoverable");

    // The caller's original id must still resolve to the (now-different) live backend advertisement.
    await dm.stopAdvertising(id);
    expect(backend.stopCalls[backend.stopCalls.length - 1]).toBe(
      "mdns-internal-2",
    );
  });

  test("per-adapter quiet/dark then discoverable re-advertises only that adapter with its own original opts", async () => {
    const dm = new DiscoveryManager();
    const mdns = fakeBackend("mdns");
    const tailscale = fakeBackend("tailscale");
    dm.registerBackend(mdns);
    dm.registerBackend(tailscale);
    const mdnsOpts: AdvertiseOptions = { name: "mesh-a", port: 19876 };
    const tsOpts: AdvertiseOptions = { name: "mesh-b", port: 19877 };

    await dm.advertise("mdns", mdnsOpts);
    await dm.advertise("tailscale", tsOpts);

    await dm.setVisibility("quiet", "mdns");
    expect(mdns.stopCalls).toHaveLength(1);
    expect(tailscale.stopCalls).toHaveLength(0);

    await dm.setVisibility("discoverable", "mdns");
    expect(mdns.startCalls).toHaveLength(2);
    expect(mdns.startCalls[1]).toEqual(mdnsOpts);
    expect(tailscale.startCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// MeshStore delegation
// ---------------------------------------------------------------------------

describe("MeshStore visibility delegation", () => {
  test("setVisibility delegates to discovery manager", async () => {
    const store = new MeshStore({ coordinatorPort: TEST_PORT });
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
    const store = new MeshStore({ coordinatorPort: TEST_PORT });
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
    const store = new MeshStore({ coordinatorPort: TEST_PORT });
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
    const store = new MeshStore({ coordinatorPort: TEST_PORT });
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
    const store = new MeshStore({ coordinatorPort: TEST_PORT });
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

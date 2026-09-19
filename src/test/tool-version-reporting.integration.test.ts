/**
 * Unit tests for the whoami/update CommsTool actions surfacing this bridge's own version and, when a newer release is known, a drift warning -- see issue #166 (the extension checkout at ~/.agents/extensions/agent-comms sat at v1.24.0 for two months while npm published 3.x, and nothing surfaced the drift until someone inspected running process command lines by hand).
 */

import { describe, it, expect } from "vitest";
import { MeshStore } from "../core/mesh-store.js";
import { CommsTool } from "../core/tool.js";
import { buildAction } from "../core/bridge.js";
import { getOwnPackageVersion } from "../core/package-version.js";
import { getWireMeshCoreVersion } from "../core/wire-mesh-core-version.js";
import { wireTestTransport } from "./test-transport.js";

async function registeredContext(
  store: MeshStore,
): Promise<{ agentId: string; harness: string; cwd: string; pid: number }> {
  const agent = await store.registerAgent({
    name: "owner",
    harness: "pi",
    cwd: "/tmp/p",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  return { agentId: agent.id, harness: "pi", cwd: "/tmp/p", pid: process.pid };
}

describe("whoami reports this bridge's own version", () => {
  it("includes a Version line matching the package's own version", async () => {
    const store = new MeshStore();
    await wireTestTransport(store);
    const ctx = await registeredContext(store);
    const tool = new CommsTool(store);

    const result = await tool.handle(ctx, buildAction({ action: "whoami" }));

    expect(result.isError).toBe(false);
    expect(result.content).toContain(`Version: ${getOwnPackageVersion()}`);
  });

  it("does not mention an available update when no newer version is known", async () => {
    const store = new MeshStore();
    await wireTestTransport(store);
    const ctx = await registeredContext(store);
    const tool = new CommsTool(store);

    const result = await tool.handle(ctx, buildAction({ action: "whoami" }));

    expect(result.content).not.toContain("Update available");
  });

  it("mentions the newer version when the injected checker reports drift", async () => {
    const store = new MeshStore();
    await wireTestTransport(store);
    const ctx = await registeredContext(store);
    const tool = new CommsTool(store, { getNewerVersionIfAny: () => "99.0.0" });

    const result = await tool.handle(ctx, buildAction({ action: "whoami" }));

    expect(result.content).toContain("Update available: 99.0.0");
  });

  it("includes a Wire-mesh-core line matching the installed dependency's own version", async () => {
    const store = new MeshStore();
    await wireTestTransport(store);
    const ctx = await registeredContext(store);
    const tool = new CommsTool(store);

    const result = await tool.handle(ctx, buildAction({ action: "whoami" }));

    expect(result.content).toContain(
      `Wire-mesh-core: ${getWireMeshCoreVersion()}`,
    );
  });

  it("does not mention a Cc-peer version when this store never wired one", async () => {
    const store = new MeshStore();
    await wireTestTransport(store);
    const ctx = await registeredContext(store);
    const tool = new CommsTool(store);

    const result = await tool.handle(ctx, buildAction({ action: "whoami" }));

    expect(result.content).not.toContain("Cc-peer:");
  });

  it("mentions the Cc-peer version once the store's own getter is set, as though fronting/bridging cc-peer", async () => {
    const store = new MeshStore();
    await wireTestTransport(store);
    const ctx = await registeredContext(store);
    const tool = new CommsTool(store);
    store.getCcPeerVersion = () => "9.9.9";

    const result = await tool.handle(ctx, buildAction({ action: "whoami" }));

    expect(result.content).toContain("Cc-peer: 9.9.9");
  });
});

describe("update reports this bridge's own version", () => {
  it("includes the package's own version in the Updated summary", async () => {
    const store = new MeshStore();
    await wireTestTransport(store);
    const ctx = await registeredContext(store);
    const tool = new CommsTool(store);

    const result = await tool.handle(
      ctx,
      buildAction({ action: "update", status: "busy" }),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain(`version=${getOwnPackageVersion()}`);
  });

  it("mentions the newer version when the injected checker reports drift", async () => {
    const store = new MeshStore();
    await wireTestTransport(store);
    const ctx = await registeredContext(store);
    const tool = new CommsTool(store, { getNewerVersionIfAny: () => "99.0.0" });

    const result = await tool.handle(
      ctx,
      buildAction({ action: "update", status: "idle" }),
    );

    expect(result.content).toContain("Update available: 99.0.0");
  });

  it("includes the installed wire-mesh-core version, and cc-peer's once wired", async () => {
    const store = new MeshStore();
    await wireTestTransport(store);
    const ctx = await registeredContext(store);
    const tool = new CommsTool(store);

    const before = await tool.handle(
      ctx,
      buildAction({ action: "update", status: "busy" }),
    );
    expect(before.content).toContain(
      `wireMeshCore=${getWireMeshCoreVersion()}`,
    );
    expect(before.content).not.toContain("ccPeer=");

    store.getCcPeerVersion = () => "9.9.9";
    const after = await tool.handle(
      ctx,
      buildAction({ action: "update", status: "idle" }),
    );
    expect(after.content).toContain("ccPeer=9.9.9");
  });
});

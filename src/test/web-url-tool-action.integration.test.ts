/**
 * CommsTool's web_url action (agent-comms#200) -- reports the calling bridge's own web UI address, or the same "not running"/"port not yet assigned" distinction pi's own comms-url command already made, so any MCP client (Claude Code, Codex, OpenCode, the generic MCP bridge) can find and open its own dashboard rather than only pi.
 */
import { test, describe, expect } from "vitest";
import { MeshStore } from "../core/mesh-store.js";
import { CommsTool } from "../core/tool.js";
import { buildAction } from "../core/bridge.js";
import { wireTestTransport } from "./test-transport.js";

async function registeredContext(
  store: MeshStore,
): Promise<{ agentId: string; harness: string; cwd: string; pid: number }> {
  const agent = await store.registerAgent({
    name: "web-url-test",
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

describe("CommsTool web_url action", () => {
  test("reports the web UI is not running when no getter is wired", async () => {
    const store = new MeshStore();
    await wireTestTransport(store);
    const ctx = await registeredContext(store);
    const tool = new CommsTool(store);

    const result = await tool.handle(ctx, buildAction({ action: "web_url" }));

    expect(result.isError).toBe(true);
    expect(result.content).toBe("Web UI is not running.");
  });

  test("reports the web UI is not running when the getter reports not_running", async () => {
    const store = new MeshStore();
    await wireTestTransport(store);
    const ctx = await registeredContext(store);
    const tool = new CommsTool(store);
    tool.getWebUrlStatus = () => ({ kind: "not_running" });

    const result = await tool.handle(ctx, buildAction({ action: "web_url" }));

    expect(result.isError).toBe(true);
    expect(result.content).toBe("Web UI is not running.");
  });

  test("reports the port as not yet assigned when the getter reports pending", async () => {
    const store = new MeshStore();
    await wireTestTransport(store);
    const ctx = await registeredContext(store);
    const tool = new CommsTool(store);
    tool.getWebUrlStatus = () => ({ kind: "pending" });

    const result = await tool.handle(ctx, buildAction({ action: "web_url" }));

    expect(result.isError).toBe(true);
    expect(result.content).toBe("Web UI port not yet assigned.");
  });

  test("reports the web UI's own URL when the getter reports ready", async () => {
    const store = new MeshStore();
    await wireTestTransport(store);
    const ctx = await registeredContext(store);
    const tool = new CommsTool(store);
    tool.getWebUrlStatus = () => ({
      kind: "ready",
      url: "http://127.0.0.1:54321",
    });

    const result = await tool.handle(ctx, buildAction({ action: "web_url" }));

    expect(result.isError).toBe(false);
    expect(result.content).toBe("http://127.0.0.1:54321");
  });
});

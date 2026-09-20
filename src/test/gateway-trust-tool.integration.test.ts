/**
 * CommsTool's gateway-trust actions (agent-comms#156) -- add/remove/list a trusted remote device-id, mirroring visibility.integration.test.ts's own "CommsTool visibility actions" pattern for the sibling mesh-only, MeshOnlyFeatures-gated config surface. Also covers the `principal` flag (agent-comms#193) that routes gateway_trust/gateway_untrust to GatewayTrust's principal-keyed allowlist (agent-comms#187) instead of the bare-device one, and gateway_list_trusted's own reporting of both sets together.
 */
import { test, describe, expect } from "vitest";
import { MeshStore } from "../core/mesh-store.js";
import { CommsTool } from "../core/tool.js";
import { buildAction } from "../core/bridge.js";
import { wireTestTransport } from "./test-transport.js";

const TEST_PORT = 0;
const DEVICE_HEX = "aabbccdd";
const ONE_HOUR_MS = 3_600_000;
const PRINCIPAL_HEX = "eeff0011";

describe("CommsTool gateway trust actions", () => {
  test("gateway_trust adds a device to the allowlist", async () => {
    const store = new MeshStore({ coordinatorPort: TEST_PORT });
    await wireTestTransport(store);
    await store.init();
    const agent = await store.registerAgent({
      name: "gateway-trust-test",
      harness: "test",
      cwd: "/test",
      pid: process.pid,
      visibility: "visible",
      tags: [],
    });
    const tool = new CommsTool(store);

    const result = await tool.handle(
      { agentId: agent.id, harness: "test", cwd: "/test", pid: process.pid },
      { action: "gateway_trust", device: DEVICE_HEX },
    );

    expect(result.isError, result.content).toBe(false);
    expect(result.content).toContain(DEVICE_HEX);
    expect(store.listTrustedGateways()).toEqual([DEVICE_HEX]);

    await store.shutdown();
  });

  test("gateway_untrust removes a device from the allowlist", async () => {
    const store = new MeshStore({ coordinatorPort: TEST_PORT });
    await wireTestTransport(store);
    await store.init();
    const agent = await store.registerAgent({
      name: "gateway-untrust-test",
      harness: "test",
      cwd: "/test",
      pid: process.pid,
      visibility: "visible",
      tags: [],
    });
    const tool = new CommsTool(store);
    store.addTrustedGateway(DEVICE_HEX);

    const result = await tool.handle(
      { agentId: agent.id, harness: "test", cwd: "/test", pid: process.pid },
      { action: "gateway_untrust", device: DEVICE_HEX },
    );

    expect(result.isError, result.content).toBe(false);
    expect(store.listTrustedGateways()).toEqual([]);

    await store.shutdown();
  });

  test("gateway_trust with principal: true adds a principal, not a bare device", async () => {
    const store = new MeshStore({ coordinatorPort: TEST_PORT });
    await wireTestTransport(store);
    await store.init();
    const agent = await store.registerAgent({
      name: "gateway-trust-principal-test",
      harness: "test",
      cwd: "/test",
      pid: process.pid,
      visibility: "visible",
      tags: [],
    });
    const tool = new CommsTool(store);

    const result = await tool.handle(
      { agentId: agent.id, harness: "test", cwd: "/test", pid: process.pid },
      { action: "gateway_trust", device: PRINCIPAL_HEX, principal: true },
    );

    expect(result.isError, result.content).toBe(false);
    expect(result.content).toContain(PRINCIPAL_HEX);
    expect(store.listTrustedGatewayPrincipals()).toEqual([PRINCIPAL_HEX]);
    expect(store.listTrustedGateways()).toEqual([]);

    await store.shutdown();
  });

  test("gateway_untrust with principal: true removes a principal, not a bare device", async () => {
    const store = new MeshStore({ coordinatorPort: TEST_PORT });
    await wireTestTransport(store);
    await store.init();
    const agent = await store.registerAgent({
      name: "gateway-untrust-principal-test",
      harness: "test",
      cwd: "/test",
      pid: process.pid,
      visibility: "visible",
      tags: [],
    });
    const tool = new CommsTool(store);
    store.addTrustedGatewayPrincipal(PRINCIPAL_HEX);
    store.addTrustedGateway(DEVICE_HEX);

    const result = await tool.handle(
      { agentId: agent.id, harness: "test", cwd: "/test", pid: process.pid },
      { action: "gateway_untrust", device: PRINCIPAL_HEX, principal: true },
    );

    expect(result.isError, result.content).toBe(false);
    expect(store.listTrustedGatewayPrincipals()).toEqual([]);
    expect(store.listTrustedGateways()).toEqual([DEVICE_HEX]);

    await store.shutdown();
  });

  test("gateway_list_trusted lists every currently trusted device", async () => {
    const store = new MeshStore({ coordinatorPort: TEST_PORT });
    await wireTestTransport(store);
    await store.init();
    const agent = await store.registerAgent({
      name: "gateway-list-test",
      harness: "test",
      cwd: "/test",
      pid: process.pid,
      visibility: "visible",
      tags: [],
    });
    const tool = new CommsTool(store);
    store.addTrustedGateway(DEVICE_HEX);

    const result = await tool.handle(
      { agentId: agent.id, harness: "test", cwd: "/test", pid: process.pid },
      { action: "gateway_list_trusted" },
    );

    expect(result.isError, result.content).toBe(false);
    expect(result.content).toContain(DEVICE_HEX);

    await store.shutdown();
  });

  test("gateway_list_trusted reports both trusted devices and trusted principals", async () => {
    const store = new MeshStore({ coordinatorPort: TEST_PORT });
    await wireTestTransport(store);
    await store.init();
    const agent = await store.registerAgent({
      name: "gateway-list-principal-test",
      harness: "test",
      cwd: "/test",
      pid: process.pid,
      visibility: "visible",
      tags: [],
    });
    const tool = new CommsTool(store);
    store.addTrustedGateway(DEVICE_HEX);
    store.addTrustedGatewayPrincipal(PRINCIPAL_HEX);

    const result = await tool.handle(
      { agentId: agent.id, harness: "test", cwd: "/test", pid: process.pid },
      { action: "gateway_list_trusted" },
    );

    expect(result.isError, result.content).toBe(false);
    expect(result.content).toContain(DEVICE_HEX);
    expect(result.content).toContain(PRINCIPAL_HEX);

    await store.shutdown();
  });

  test("gateway_list_trusted reports a device trusted only through a principal, with the principal that vouches for it", async () => {
    const store = new MeshStore({ coordinatorPort: TEST_PORT });
    await wireTestTransport(store);
    await store.init();
    const agent = await store.registerAgent({
      name: "gateway-list-member-test",
      harness: "test",
      cwd: "/test",
      pid: process.pid,
      visibility: "visible",
      tags: [],
    });
    const tool = new CommsTool(store);
    const memberHex = "1234567812345678";
    store.addTrustedGatewayPrincipal(PRINCIPAL_HEX);
    store.gatewayTrust.noteVerifiedMember(
      memberHex,
      PRINCIPAL_HEX,
      Date.now() + ONE_HOUR_MS,
    );

    const result = await tool.handle(
      { agentId: agent.id, harness: "test", cwd: "/test", pid: process.pid },
      { action: "gateway_list_trusted" },
    );

    expect(result.isError, result.content).toBe(false);
    expect(result.content).toContain(
      `Devices trusted through a principal:\n  ${memberHex} (vouched for by ${PRINCIPAL_HEX})`,
    );

    await store.shutdown();
  });

  test("gateway_list_trusted reports none trusted by default", async () => {
    const store = new MeshStore({ coordinatorPort: TEST_PORT });
    await wireTestTransport(store);
    await store.init();
    const agent = await store.registerAgent({
      name: "gateway-list-empty-test",
      harness: "test",
      cwd: "/test",
      pid: process.pid,
      visibility: "visible",
      tags: [],
    });
    const tool = new CommsTool(store);

    const result = await tool.handle(
      { agentId: agent.id, harness: "test", cwd: "/test", pid: process.pid },
      { action: "gateway_list_trusted" },
    );

    expect(result.isError, result.content).toBe(false);
    expect(store.listTrustedGateways()).toEqual([]);

    await store.shutdown();
  });
});

describe("buildAction gateway trust parsing", () => {
  test("buildAction parses gateway_trust", () => {
    const action = buildAction({
      action: "gateway_trust",
      device: DEVICE_HEX,
    });
    expect(action.action).toBe("gateway_trust");
    if (action.action === "gateway_trust") {
      expect(action.device).toBe(DEVICE_HEX);
    }
  });

  test("buildAction parses gateway_untrust", () => {
    const action = buildAction({
      action: "gateway_untrust",
      device: DEVICE_HEX,
    });
    expect(action.action).toBe("gateway_untrust");
    if (action.action === "gateway_untrust") {
      expect(action.device).toBe(DEVICE_HEX);
    }
  });

  test("buildAction parses gateway_list_trusted", () => {
    const action = buildAction({ action: "gateway_list_trusted" });
    expect(action.action).toBe("gateway_list_trusted");
  });

  test("buildAction throws for gateway_trust without device", () => {
    expect(() => buildAction({ action: "gateway_trust" })).toThrow(/device/);
  });

  test("buildAction throws for gateway_untrust without device", () => {
    expect(() => buildAction({ action: "gateway_untrust" })).toThrow(/device/);
  });

  test("buildAction parses gateway_trust with principal: true", () => {
    const action = buildAction({
      action: "gateway_trust",
      device: PRINCIPAL_HEX,
      principal: true,
    });
    expect(action.action).toBe("gateway_trust");
    if (action.action === "gateway_trust") {
      expect(action.device).toBe(PRINCIPAL_HEX);
      expect(action.principal).toBe(true);
    }
  });

  test("buildAction parses gateway_untrust with principal: true", () => {
    const action = buildAction({
      action: "gateway_untrust",
      device: PRINCIPAL_HEX,
      principal: true,
    });
    expect(action.action).toBe("gateway_untrust");
    if (action.action === "gateway_untrust") {
      expect(action.device).toBe(PRINCIPAL_HEX);
      expect(action.principal).toBe(true);
    }
  });

  test("buildAction omits principal for gateway_trust when not given", () => {
    const action = buildAction({
      action: "gateway_trust",
      device: DEVICE_HEX,
    });
    expect(action.action).toBe("gateway_trust");
    if (action.action === "gateway_trust") {
      expect(action.principal).toBeUndefined();
    }
  });
});

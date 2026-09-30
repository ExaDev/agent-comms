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
const MACHINE_HEX = "99887766";

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
      { kind: "principal", issuer: PRINCIPAL_HEX },
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

  test("gateway_trust and gateway_untrust with machine: true add and revoke a machine, and gateway_list_trusted reports it and its devices", async () => {
    const store = new MeshStore({ coordinatorPort: TEST_PORT });
    await wireTestTransport(store);
    await store.init();
    const agent = await store.registerAgent({
      name: "gateway-trust-machine-test",
      harness: "test",
      cwd: "/test",
      pid: process.pid,
      visibility: "visible",
      tags: [],
    });
    const tool = new CommsTool(store);
    const ctx = {
      agentId: agent.id,
      harness: "test",
      cwd: "/test",
      pid: process.pid,
    };
    const memberHex = "8765432187654321";

    const trusted = await tool.handle(
      ctx,
      buildAction({
        action: "gateway_trust",
        device: MACHINE_HEX,
        machine: true,
      }),
    );
    expect(trusted.isError, trusted.content).toBe(false);
    expect(store.listTrustedGatewayMachines()).toEqual([MACHINE_HEX]);
    expect(store.listTrustedGateways()).toEqual([]);
    expect(store.listTrustedGatewayPrincipals()).toEqual([]);

    store.gatewayTrust.noteVerifiedMember(
      memberHex,
      { kind: "machine", issuer: MACHINE_HEX },
      Date.now() + ONE_HOUR_MS,
    );
    const listed = await tool.handle(ctx, { action: "gateway_list_trusted" });
    expect(listed.content).toContain(
      `Trusted remote machines:\n  ${MACHINE_HEX}`,
    );
    expect(listed.content).toContain(
      `Devices trusted through a machine:\n  ${memberHex} (runs on ${MACHINE_HEX})`,
    );

    const untrusted = await tool.handle(ctx, {
      action: "gateway_untrust",
      device: MACHINE_HEX,
      machine: true,
    });
    expect(untrusted.isError, untrusted.content).toBe(false);
    expect(store.listTrustedGatewayMachines()).toEqual([]);
    expect(store.gatewayTrust.isReachable(memberHex)).toBe(false);

    await store.shutdown();
  });

  test("gateway_trust refuses an id named as both a principal and a machine", async () => {
    const store = new MeshStore({ coordinatorPort: TEST_PORT });
    await wireTestTransport(store);
    await store.init();
    const agent = await store.registerAgent({
      name: "gateway-trust-both-test",
      harness: "test",
      cwd: "/test",
      pid: process.pid,
      visibility: "visible",
      tags: [],
    });
    const tool = new CommsTool(store);

    const result = await tool.handle(
      { agentId: agent.id, harness: "test", cwd: "/test", pid: process.pid },
      {
        action: "gateway_trust",
        device: MACHINE_HEX,
        principal: true,
        machine: true,
      },
    );

    expect(result.isError).toBe(true);
    expect(store.listTrustedGatewayMachines()).toEqual([]);
    expect(store.listTrustedGatewayPrincipals()).toEqual([]);

    await store.shutdown();
  });
});

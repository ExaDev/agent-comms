/**
 * What an agent is told about connection codes says that an unsigned one is a bearer hint, not authentication: in the parameters of the tool and in the result of redeeming one.
 */
import { describe, expect, test } from "vitest";
import { MCP_TOOL_PARAMS } from "../core/bridge.js";
import { MeshStore } from "../core/mesh-store.js";
import { CommsTool } from "../core/tool.js";
import { wireTestTransport } from "./test-transport.js";

const TEST_PORT = 0;

describe("what an agent is told about an unsigned connection code", () => {
  test("the result of redeeming one says it shows nothing about who issued it", async () => {
    const issuer = new MeshStore({ coordinatorPort: TEST_PORT });
    await wireTestTransport(issuer);
    await issuer.init();
    const redeemer = new MeshStore({ coordinatorPort: TEST_PORT });
    await wireTestTransport(redeemer);
    await redeemer.init();
    try {
      const code = await issuer.generateConnectionCode();
      const agent = await redeemer.registerAgent({
        name: "redeemer",
        harness: "test",
        cwd: "/test",
        pid: process.pid,
        visibility: "visible",
        tags: [],
      });

      const accepted = await new CommsTool(redeemer).handle(
        {
          agentId: agent.id,
          harness: "test",
          cwd: "/test",
          pid: process.pid,
        },
        {
          action: "gateway_redeem_connection_code",
          code: code.code,
          expiresAt: code.expiresAt,
          device: code.deviceId,
        },
      );

      expect(accepted.isError, accepted.content).toBe(false);
      expect(accepted.content).toContain("says nothing about who issued it");
    } finally {
      await issuer.shutdown();
      await redeemer.shutdown();
    }
  });

  test("the parameters the tool shows say that an unsigned code authenticates nothing", () => {
    const { shape } = MCP_TOOL_PARAMS;
    for (const field of [shape.code, shape.publicKey, shape.fingerprint]) {
      expect(field.description).toBeDefined();
    }
    expect(shape.code.description).toContain("bearer hint, not authentication");
    expect(shape.fingerprint.description).toContain("unsigned code refused");
  });
});

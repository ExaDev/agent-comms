/**
 * The connection-code tool action under a caller's pin: an unsigned code is refused whether or not the caller supplied a fingerprint or key, and nothing is trusted by the refusal.
 */
import { describe, expect, test } from "vitest";
import { MeshStore } from "../core/mesh-store.js";
import { CommsTool } from "../core/tool.js";
import { wireTestTransport } from "./test-transport.js";

const TEST_PORT = 0;
const FINGERPRINT = "aabbccddeeff00112233445566778899aabbccdd";

describe("gateway_redeem_connection_code with a pin", () => {
  test("refuses an unsigned code, pinned or not, and trusts nothing", async () => {
    const issuer = new MeshStore({ coordinatorPort: TEST_PORT });
    await wireTestTransport(issuer);
    await issuer.init();
    const redeemer = new MeshStore({ coordinatorPort: TEST_PORT });
    await wireTestTransport(redeemer);
    await redeemer.init();
    try {
      const code = await issuer.generateConnectionCode();
      const tool = new CommsTool(redeemer);
      const agent = await redeemer.registerAgent({
        name: "redeemer",
        harness: "test",
        cwd: "/test",
        pid: process.pid,
        visibility: "visible",
        tags: [],
      });
      const context = {
        agentId: agent.id,
        harness: "test",
        cwd: "/test",
        pid: process.pid,
      };

      const refused = await tool.handle(context, {
        action: "gateway_redeem_connection_code",
        code: code.code,
        expiresAt: code.expiresAt,
        device: code.deviceId,
        fingerprint: FINGERPRINT,
      });

      expect(refused.isError).toBe(true);
      expect(refused.content).toContain("not signed");
      expect(redeemer.listTrustedGateways()).toEqual([]);

      const unpinned = await tool.handle(context, {
        action: "gateway_redeem_connection_code",
        code: code.code,
        expiresAt: code.expiresAt,
        device: code.deviceId,
      });

      expect(unpinned.isError).toBe(true);
      expect(redeemer.listTrustedGateways()).toEqual([]);
    } finally {
      await issuer.shutdown();
      await redeemer.shutdown();
    }
  });
});

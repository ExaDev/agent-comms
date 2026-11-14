/**
 * The connection-code tool actions under a caller's pin: an unsigned code is refused when the caller supplied a fingerprint or key, an expiry that is not a timestamp is refused, and nothing is trusted by either refusal.
 */
import { describe, expect, test } from "vitest";
import { MeshStore } from "../core/mesh-store.js";
import { CommsTool } from "../core/tool.js";
import { wireTestTransport } from "./test-transport.js";

const TEST_PORT = 0;
const FINGERPRINT = "aabbccddeeff00112233445566778899aabbccdd";

describe("gateway_redeem_connection_code with a pin", () => {
  test("refuses an unsigned code and trusts nothing", async () => {
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

      const badExpiry = await tool.handle(context, {
        action: "gateway_redeem_connection_code",
        code: code.code,
        expiresAt: "soon",
        device: code.deviceId,
      });

      expect(badExpiry.isError).toBe(true);
      expect(badExpiry.content).toContain("ISO 8601");
      expect(redeemer.listTrustedGateways()).toEqual([]);

      const accepted = await tool.handle(context, {
        action: "gateway_redeem_connection_code",
        code: code.code,
        expiresAt: code.expiresAt,
        device: code.deviceId,
      });

      expect(accepted.isError, accepted.content).toBe(false);
      expect(redeemer.listTrustedGateways()).toEqual([issuer.peerId]);
    } finally {
      await issuer.shutdown();
      await redeemer.shutdown();
    }
  });
});

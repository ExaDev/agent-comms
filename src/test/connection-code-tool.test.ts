/**
 * CommsTool's gateway_generate_connection_code/gateway_redeem_connection_code actions (agent-comms#188), mirroring gateway-trust-tool.test.ts's own pattern for the sibling gateway-trust actions -- an end-to-end pass through CommsTool.handle, MeshStore, and ConnectionCodeLedger, ending in a real gatewayTrust.add on successful redemption.
 */
import { test, describe, expect } from "vitest";
import * as openpgp from "openpgp";
import { MeshStore } from "../core/mesh-store.js";
import { CommsTool } from "../core/tool.js";
import { buildAction } from "../core/bridge.js";
import { wireTestTransport } from "./test-transport.js";

const TEST_PORT = 0;
/** A generic "far enough in the future"/"far enough in the past" offset, used wherever a test needs an expired or not-yet-expired timestamp without caring about the exact margin. */
const ONE_MINUTE_MS = 60_000;

async function registerAgent(store: MeshStore, name: string) {
  return store.registerAgent({
    name,
    harness: "test",
    cwd: "/test",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
}

describe("CommsTool connection-code actions", () => {
  test("gateway_generate_connection_code returns a bare code vouching for this store's own device-id", async () => {
    const store = new MeshStore(TEST_PORT);
    await wireTestTransport(store);
    await store.init();
    const agent = await registerAgent(store, "connection-code-generate-test");
    const tool = new CommsTool(store);

    const result = await tool.handle(
      { agentId: agent.id, harness: "test", cwd: "/test", pid: process.pid },
      { action: "gateway_generate_connection_code" },
    );

    expect(result.isError, result.content).toBe(false);
    expect(result.content).toContain("unsigned");
    expect(result.content).toContain(`"deviceId":"${store.peerId}"`);

    await store.shutdown();
  });

  test("gateway_redeem_connection_code trusts the vouched-for device on success", async () => {
    const issuerStore = new MeshStore(TEST_PORT);
    await wireTestTransport(issuerStore);
    await issuerStore.init();
    const issuerTool = new CommsTool(issuerStore);
    const issuerAgent = await registerAgent(issuerStore, "issuer");

    const generateResult = await issuerTool.handle(
      {
        agentId: issuerAgent.id,
        harness: "test",
        cwd: "/test",
        pid: process.pid,
      },
      { action: "gateway_generate_connection_code" },
    );
    const code: { code: string; expiresAt: string; deviceId: string } =
      JSON.parse(generateResult.content.split("\n").at(-1) ?? "{}");

    const redeemerStore = new MeshStore(TEST_PORT);
    await wireTestTransport(redeemerStore);
    await redeemerStore.init();
    const redeemerTool = new CommsTool(redeemerStore);
    const redeemerAgent = await registerAgent(redeemerStore, "redeemer");

    const redeemResult = await redeemerTool.handle(
      {
        agentId: redeemerAgent.id,
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

    expect(redeemResult.isError, redeemResult.content).toBe(false);
    expect(redeemerStore.listTrustedGateways()).toEqual([issuerStore.peerId]);

    await issuerStore.shutdown();
    await redeemerStore.shutdown();
  });

  test("gateway_redeem_connection_code rejects an expired code without trusting anything", async () => {
    const store = new MeshStore(TEST_PORT);
    await wireTestTransport(store);
    await store.init();
    const tool = new CommsTool(store);
    const agent = await registerAgent(store, "expired-redeem-test");

    const result = await tool.handle(
      { agentId: agent.id, harness: "test", cwd: "/test", pid: process.pid },
      {
        action: "gateway_redeem_connection_code",
        code: "some-nonce",
        expiresAt: new Date(Date.now() - ONE_MINUTE_MS).toISOString(),
        device: "aabbcc",
      },
    );

    expect(result.isError, result.content).toBe(true);
    expect(result.content).toContain("expired");
    expect(store.listTrustedGateways()).toEqual([]);

    await store.shutdown();
  });

  test("gateway_generate_connection_code signs the code when a private key is supplied", async () => {
    const store = new MeshStore(TEST_PORT);
    await wireTestTransport(store);
    await store.init();
    const tool = new CommsTool(store);
    const agent = await registerAgent(store, "signed-generate-test");
    const { privateKey } = await openpgp.generateKey({
      type: "ecc",
      curve: "curve25519Legacy",
      userIDs: [{ name: "Alice", email: "alice@example.com" }],
      format: "armored",
    });

    const result = await tool.handle(
      { agentId: agent.id, harness: "test", cwd: "/test", pid: process.pid },
      { action: "gateway_generate_connection_code", privateKey },
    );

    expect(result.isError, result.content).toBe(false);
    expect(result.content).toContain("PGP-signed");

    await store.shutdown();
  });

  test("gateway_redeem_connection_code verifies a signature against a pasted public key", async () => {
    const { privateKey, publicKey } = await openpgp.generateKey({
      type: "ecc",
      curve: "curve25519Legacy",
      userIDs: [{ name: "Alice", email: "alice@example.com" }],
      format: "armored",
    });

    const issuerStore = new MeshStore(TEST_PORT);
    await wireTestTransport(issuerStore);
    await issuerStore.init();
    const issuerTool = new CommsTool(issuerStore);
    const issuerAgent = await registerAgent(issuerStore, "signed-issuer");

    const generateResult = await issuerTool.handle(
      {
        agentId: issuerAgent.id,
        harness: "test",
        cwd: "/test",
        pid: process.pid,
      },
      { action: "gateway_generate_connection_code", privateKey },
    );
    const code: {
      code: string;
      expiresAt: string;
      deviceId: string;
      signature: string;
    } = JSON.parse(generateResult.content.split("\n").at(-1) ?? "{}");

    const redeemerStore = new MeshStore(TEST_PORT);
    await wireTestTransport(redeemerStore);
    await redeemerStore.init();
    const redeemerTool = new CommsTool(redeemerStore);
    const redeemerAgent = await registerAgent(redeemerStore, "signed-redeemer");

    const redeemResult = await redeemerTool.handle(
      {
        agentId: redeemerAgent.id,
        harness: "test",
        cwd: "/test",
        pid: process.pid,
      },
      {
        action: "gateway_redeem_connection_code",
        code: code.code,
        expiresAt: code.expiresAt,
        device: code.deviceId,
        signature: code.signature,
        publicKey,
      },
    );

    expect(redeemResult.isError, redeemResult.content).toBe(false);
    expect(redeemResult.content).toContain("signature verified");
    expect(redeemerStore.listTrustedGateways()).toEqual([issuerStore.peerId]);

    await issuerStore.shutdown();
    await redeemerStore.shutdown();
  });

  test("gateway_redeem_connection_code fetches the public key from a keyserver when only a fingerprint is supplied", async () => {
    const { privateKey, publicKey } = await openpgp.generateKey({
      type: "ecc",
      curve: "curve25519Legacy",
      userIDs: [{ name: "Alice", email: "alice@example.com" }],
      format: "armored",
    });
    const readKey = await openpgp.readKey({ armoredKey: publicKey });
    const fingerprint = readKey.getFingerprint();

    const issuerStore = new MeshStore(TEST_PORT);
    await wireTestTransport(issuerStore);
    await issuerStore.init();
    const issuerTool = new CommsTool(issuerStore);
    const issuerAgent = await registerAgent(issuerStore, "keyserver-issuer");

    const generateResult = await issuerTool.handle(
      {
        agentId: issuerAgent.id,
        harness: "test",
        cwd: "/test",
        pid: process.pid,
      },
      { action: "gateway_generate_connection_code", privateKey },
    );
    const code: {
      code: string;
      expiresAt: string;
      deviceId: string;
      signature: string;
    } = JSON.parse(generateResult.content.split("\n").at(-1) ?? "{}");

    const redeemerStore = new MeshStore(TEST_PORT);
    await wireTestTransport(redeemerStore);
    await redeemerStore.init();
    const fetchPgpPublicKeyByFingerprintImpl = async (
      requestedFingerprint: string,
    ): Promise<string> => {
      expect(requestedFingerprint).toBe(fingerprint);
      return publicKey;
    };
    const redeemerTool = new CommsTool(
      redeemerStore,
      undefined,
      undefined,
      fetchPgpPublicKeyByFingerprintImpl,
    );
    const redeemerAgent = await registerAgent(
      redeemerStore,
      "keyserver-redeemer",
    );

    const redeemResult = await redeemerTool.handle(
      {
        agentId: redeemerAgent.id,
        harness: "test",
        cwd: "/test",
        pid: process.pid,
      },
      {
        action: "gateway_redeem_connection_code",
        code: code.code,
        expiresAt: code.expiresAt,
        device: code.deviceId,
        signature: code.signature,
        fingerprint,
      },
    );

    expect(redeemResult.isError, redeemResult.content).toBe(false);
    expect(redeemerStore.listTrustedGateways()).toEqual([issuerStore.peerId]);

    await issuerStore.shutdown();
    await redeemerStore.shutdown();
  });

  test("gateway_redeem_connection_code reports a keyserver lookup failure without trusting anything", async () => {
    const redeemerStore = new MeshStore(TEST_PORT);
    await wireTestTransport(redeemerStore);
    await redeemerStore.init();
    const failingFetch = async (): Promise<string> => {
      throw new Error("HTTP 404");
    };
    const redeemerTool = new CommsTool(
      redeemerStore,
      undefined,
      undefined,
      failingFetch,
    );
    const redeemerAgent = await registerAgent(
      redeemerStore,
      "keyserver-failure-redeemer",
    );

    const redeemResult = await redeemerTool.handle(
      {
        agentId: redeemerAgent.id,
        harness: "test",
        cwd: "/test",
        pid: process.pid,
      },
      {
        action: "gateway_redeem_connection_code",
        code: "some-nonce",
        expiresAt: new Date(Date.now() + ONE_MINUTE_MS).toISOString(),
        device: "aabbcc",
        signature:
          "-----BEGIN PGP SIGNATURE-----\nfake\n-----END PGP SIGNATURE-----",
        fingerprint: "0000000000000000000000000000000000000000",
      },
    );

    expect(redeemResult.isError, redeemResult.content).toBe(true);
    expect(redeemResult.content).toContain("Failed to fetch PGP public key");
    expect(redeemerStore.listTrustedGateways()).toEqual([]);

    await redeemerStore.shutdown();
  });
});

describe("buildAction connection-code parsing", () => {
  test("buildAction parses gateway_generate_connection_code with no fields", () => {
    const action = buildAction({ action: "gateway_generate_connection_code" });
    expect(action.action).toBe("gateway_generate_connection_code");
  });

  test("buildAction parses gateway_generate_connection_code's optional fields", () => {
    const action = buildAction({
      action: "gateway_generate_connection_code",
      ttlMs: ONE_MINUTE_MS,
      privateKey: "armored-key",
      passphrase: "secret",
    });
    expect(action.action).toBe("gateway_generate_connection_code");
    if (action.action === "gateway_generate_connection_code") {
      expect(action.ttlMs).toBe(ONE_MINUTE_MS);
      expect(action.privateKey).toBe("armored-key");
      expect(action.passphrase).toBe("secret");
    }
  });

  test("buildAction parses gateway_redeem_connection_code's required fields", () => {
    const action = buildAction({
      action: "gateway_redeem_connection_code",
      code: "nonce",
      expiresAt: "2026-01-01T00:00:00.000Z",
      device: "aabbcc",
    });
    expect(action.action).toBe("gateway_redeem_connection_code");
    if (action.action === "gateway_redeem_connection_code") {
      expect(action.code).toBe("nonce");
      expect(action.expiresAt).toBe("2026-01-01T00:00:00.000Z");
      expect(action.device).toBe("aabbcc");
      expect(action.signature).toBeUndefined();
    }
  });

  test("buildAction parses gateway_redeem_connection_code's optional signature/publicKey/fingerprint", () => {
    const action = buildAction({
      action: "gateway_redeem_connection_code",
      code: "nonce",
      expiresAt: "2026-01-01T00:00:00.000Z",
      device: "aabbcc",
      signature: "sig",
      publicKey: "pubkey",
      fingerprint: "fpr",
    });
    expect(action.action).toBe("gateway_redeem_connection_code");
    if (action.action === "gateway_redeem_connection_code") {
      expect(action.signature).toBe("sig");
      expect(action.publicKey).toBe("pubkey");
      expect(action.fingerprint).toBe("fpr");
    }
  });

  test("buildAction throws for gateway_redeem_connection_code without code", () => {
    expect(() =>
      buildAction({
        action: "gateway_redeem_connection_code",
        expiresAt: "2026-01-01T00:00:00.000Z",
        device: "aabbcc",
      }),
    ).toThrow(/code/);
  });

  test("buildAction throws for gateway_redeem_connection_code without expiresAt", () => {
    expect(() =>
      buildAction({
        action: "gateway_redeem_connection_code",
        code: "nonce",
        device: "aabbcc",
      }),
    ).toThrow(/expiresAt/);
  });

  test("buildAction throws for gateway_redeem_connection_code without device", () => {
    expect(() =>
      buildAction({
        action: "gateway_redeem_connection_code",
        code: "nonce",
        expiresAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow(/device/);
  });
});

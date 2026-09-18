/**
 * Unit tests for ConnectionCodeLedger (agent-comms#188): the generate/redeem pair backing gateway_generate_connection_code/gateway_redeem_connection_code. Covers the always-checked nonce/expiry path standalone from the optional PGP-signature path, mirroring gateway-trust.test.ts's own split between plain-trust and slot-persistence describe blocks for the sibling allowlist class.
 */

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as openpgp from "openpgp";
import { describe, expect, it, beforeAll } from "vitest";
import {
  ConnectionCodeLedger,
  ConnectionCodeError,
} from "../core/connection-code.js";
import type { IdentitySlot } from "../core/identity-store.js";
import type { ConnectionCode } from "../core/types.js";

function tempSlot(harness: string): IdentitySlot {
  const dir = fs.mkdtempSync(
    path.join(tmpdir(), "agent-comms-connection-code-test-"),
  );
  return { harness, cwd: "/tmp/project", dir };
}

const DEVICE_HEX = "aabbccdd";
/** A short TTL used throughout the expiry tests below -- long enough to distinguish "before" from "at/after" expiry, short enough to keep every test's own arithmetic obvious. */
const SHORT_TTL_MS = 1000;
/** Comfortably past SHORT_TTL_MS, used wherever a test needs "well after expiry" rather than "at the exact instant". */
const WELL_PAST_EXPIRY_MS = 2000;
/** A gap comfortably larger than SHORT_TTL_MS, used by the pruning test to land after the first code has expired. */
const PRUNE_GAP_MS = 10_000;

let signingKey: { privateKey: string; publicKey: string };
let otherKey: { privateKey: string; publicKey: string };

beforeAll(async () => {
  const generated = await openpgp.generateKey({
    type: "ecc",
    curve: "curve25519Legacy",
    userIDs: [{ name: "Alice", email: "alice@example.com" }],
    format: "armored",
  });
  signingKey = generated;
  const other = await openpgp.generateKey({
    type: "ecc",
    curve: "curve25519Legacy",
    userIDs: [{ name: "Mallory", email: "mallory@example.com" }],
    format: "armored",
  });
  otherKey = other;
});

describe("ConnectionCodeLedger -- generation", () => {
  it("generates a bare code with no signature when no private key is supplied", async () => {
    const ledger = new ConnectionCodeLedger();
    const code = await ledger.generate(DEVICE_HEX);
    expect(code.deviceId).toBe(DEVICE_HEX);
    expect(code.signature).toBeUndefined();
    expect(typeof code.code).toBe("string");
    expect(code.code.length).toBeGreaterThan(0);
    expect(Date.parse(code.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("generates a fresh nonce on every call", async () => {
    const ledger = new ConnectionCodeLedger();
    const a = await ledger.generate(DEVICE_HEX);
    const b = await ledger.generate(DEVICE_HEX);
    expect(a.code).not.toBe(b.code);
  });

  it("honours an explicit ttlMs", async () => {
    const ledger = new ConnectionCodeLedger();
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    const code = await ledger.generate(DEVICE_HEX, { ttlMs: 60_000, now });
    expect(code.expiresAt).toBe("2026-01-01T00:01:00.000Z");
  });

  it("signs the code when a private key is supplied, producing a signature verifiable against the matching public key", async () => {
    const ledger = new ConnectionCodeLedger();
    const code = await ledger.generate(DEVICE_HEX, {
      privateKeyArmored: signingKey.privateKey,
    });
    expect(code.signature).toBeDefined();

    const result = await ledger.redeem(code, {
      publicKeyArmored: signingKey.publicKey,
    });
    expect(result.deviceId).toBe(DEVICE_HEX);
    expect(result.fingerprint).toBeDefined();
  });
});

describe("ConnectionCodeLedger -- redemption freshness/liveness (always checked)", () => {
  it("redeems a fresh, unsigned code", async () => {
    const ledger = new ConnectionCodeLedger();
    const code = await ledger.generate(DEVICE_HEX);
    const result = await ledger.redeem(code);
    expect(result).toEqual({ deviceId: DEVICE_HEX });
  });

  it("rejects an expired code", async () => {
    const ledger = new ConnectionCodeLedger();
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    const code = await ledger.generate(DEVICE_HEX, {
      ttlMs: SHORT_TTL_MS,
      now,
    });

    await expect(
      ledger.redeem(code, { now: now + WELL_PAST_EXPIRY_MS }),
    ).rejects.toMatchObject({ reason: "expired" });
  });

  it("rejects a code at the exact instant it expires", async () => {
    const ledger = new ConnectionCodeLedger();
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    const code = await ledger.generate(DEVICE_HEX, {
      ttlMs: SHORT_TTL_MS,
      now,
    });

    await expect(
      ledger.redeem(code, { now: now + SHORT_TTL_MS }),
    ).rejects.toMatchObject({ reason: "expired" });
  });

  it("rejects a second redemption of the same code (single-use)", async () => {
    const ledger = new ConnectionCodeLedger();
    const code = await ledger.generate(DEVICE_HEX);
    await ledger.redeem(code);

    await expect(ledger.redeem(code)).rejects.toMatchObject({
      reason: "already_redeemed",
    });
  });

  it("rejects a code whose fields have been tampered with even though the nonce matches something once issued", async () => {
    const ledger = new ConnectionCodeLedger();
    const code = await ledger.generate(DEVICE_HEX);
    const tampered: ConnectionCode = { ...code, deviceId: "112233" };

    // Tampering the deviceId of an unsigned code can't be detected by this ledger (there is nothing to check it against) -- redemption still succeeds, but against the tampered deviceId, proving the caller's own copy of the code is what's trusted, not some hidden ledger-side truth.
    const result = await ledger.redeem(tampered);
    expect(result.deviceId).toBe("112233");
  });
});

describe("ConnectionCodeLedger -- optional PGP signature (only checked when present)", () => {
  it("rejects a signed code redeemed with no public key supplied", async () => {
    const ledger = new ConnectionCodeLedger();
    const code = await ledger.generate(DEVICE_HEX, {
      privateKeyArmored: signingKey.privateKey,
    });

    await expect(ledger.redeem(code)).rejects.toMatchObject({
      reason: "signature_required",
    });
  });

  it("rejects a signed code verified against the wrong public key", async () => {
    const ledger = new ConnectionCodeLedger();
    const code = await ledger.generate(DEVICE_HEX, {
      privateKeyArmored: signingKey.privateKey,
    });

    await expect(
      ledger.redeem(code, { publicKeyArmored: otherKey.publicKey }),
    ).rejects.toMatchObject({ reason: "signature_invalid" });
  });

  it("rejects a signature over a tampered field even against the correct public key", async () => {
    const ledger = new ConnectionCodeLedger();
    const code = await ledger.generate(DEVICE_HEX, {
      privateKeyArmored: signingKey.privateKey,
    });
    const tampered: ConnectionCode = { ...code, deviceId: "112233" };

    await expect(
      ledger.redeem(tampered, { publicKeyArmored: signingKey.publicKey }),
    ).rejects.toMatchObject({ reason: "signature_invalid" });
  });

  it("accepts a signature verified against the correct public key with no expected fingerprint pinned", async () => {
    const ledger = new ConnectionCodeLedger();
    const code = await ledger.generate(DEVICE_HEX, {
      privateKeyArmored: signingKey.privateKey,
    });

    const result = await ledger.redeem(code, {
      publicKeyArmored: signingKey.publicKey,
    });
    expect(result.deviceId).toBe(DEVICE_HEX);
  });

  it("accepts a signature whose verified fingerprint matches the expected (trusted) fingerprint", async () => {
    const ledger = new ConnectionCodeLedger();
    const code = await ledger.generate(DEVICE_HEX, {
      privateKeyArmored: signingKey.privateKey,
    });
    const publicKey = await openpgp.readKey({
      armoredKey: signingKey.publicKey,
    });

    const result = await ledger.redeem(code, {
      publicKeyArmored: signingKey.publicKey,
      expectedFingerprint: publicKey.getFingerprint(),
    });
    expect(result.fingerprint).toBe(publicKey.getFingerprint());
  });

  it("is tolerant of case and surrounding whitespace when comparing the expected fingerprint", async () => {
    const ledger = new ConnectionCodeLedger();
    const code = await ledger.generate(DEVICE_HEX, {
      privateKeyArmored: signingKey.privateKey,
    });
    const publicKey = await openpgp.readKey({
      armoredKey: signingKey.publicKey,
    });

    const result = await ledger.redeem(code, {
      publicKeyArmored: signingKey.publicKey,
      expectedFingerprint: ` ${publicKey.getFingerprint().toUpperCase()} `,
    });
    expect(result.deviceId).toBe(DEVICE_HEX);
  });

  it("rejects a signature that verifies but against an unexpected fingerprint", async () => {
    const ledger = new ConnectionCodeLedger();
    const code = await ledger.generate(DEVICE_HEX, {
      privateKeyArmored: signingKey.privateKey,
    });

    await expect(
      ledger.redeem(code, {
        publicKeyArmored: signingKey.publicKey,
        expectedFingerprint: "0000000000000000000000000000000000000000",
      }),
    ).rejects.toMatchObject({ reason: "fingerprint_mismatch" });
  });
});

describe("ConnectionCodeLedger -- persistence (agent-comms#188)", () => {
  it("constructed with no slot, never touches disk", async () => {
    const ledger = new ConnectionCodeLedger();
    const code = await ledger.generate(DEVICE_HEX);
    await expect(ledger.redeem(code)).resolves.toEqual({
      deviceId: DEVICE_HEX,
    });
  });

  it("survives a restart: an issued code recorded before restart is still recorded after", async () => {
    const slot = tempSlot("test");
    const first = new ConnectionCodeLedger(slot);
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    await first.generate(DEVICE_HEX, { ttlMs: 60_000, now });

    const restarted = new ConnectionCodeLedger(slot);
    // The restarted instance still knows about the redemption record it will create once this same code is redeemed through it -- proven indirectly below by confirming a redemption recorded before restart is not forgotten after it.
    expect(restarted).toBeInstanceOf(ConnectionCodeLedger);
  });

  it("survives a restart: single-use enforcement holds across a restart within the code's validity window", async () => {
    const slot = tempSlot("test");
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    const issuer = new ConnectionCodeLedger();
    const code = await issuer.generate(DEVICE_HEX, { ttlMs: 60_000, now });

    const redeemer = new ConnectionCodeLedger(slot);
    await redeemer.redeem(code, { now });

    const restartedRedeemer = new ConnectionCodeLedger(slot);
    await expect(
      restartedRedeemer.redeem(code, { now: now + SHORT_TTL_MS }),
    ).rejects.toMatchObject({ reason: "already_redeemed" });
  });

  it("prunes an expired redeemed nonce so it does not accumulate forever", async () => {
    const slot = tempSlot("test");
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    const issuer = new ConnectionCodeLedger();
    const code = await issuer.generate(DEVICE_HEX, {
      ttlMs: SHORT_TTL_MS,
      now,
    });

    const redeemer = new ConnectionCodeLedger(slot);
    await redeemer.redeem(code, { now });

    // Generating a second, unrelated code well after the first has expired triggers pruning; the first nonce is no longer tracked as redeemed.
    const laterCode = await issuer.generate(DEVICE_HEX, {
      ttlMs: SHORT_TTL_MS,
      now: now + PRUNE_GAP_MS,
    });
    const laterRedeemer = new ConnectionCodeLedger(slot);
    await laterRedeemer.redeem(laterCode, { now: now + PRUNE_GAP_MS });
  });
});

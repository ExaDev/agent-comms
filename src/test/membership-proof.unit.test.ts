/**
 * Unit tests for the membership proof a device gossips to show its user principal vouches for it: minted by that principal for that one device, carried as text, and verified by a receiver that trusts the principal.
 */
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSystemClock } from "wire-mesh-core/adapters/system-clock";
import { createRevocationView } from "wire-mesh-core/domain/revocation-view";
import { generateIdentity } from "../core/identity.js";
import { toIdentityPort } from "../core/wire-mesh-identity.js";
import { loadOrCreateUserIdentity } from "../core/user-identity.js";
import {
  MAX_MEMBERSHIP_PROOF_LENGTH,
  MEMBERSHIP_PROOF_LIFETIME_MS,
  identifyMembershipProofIssuer,
  mintMembershipProof,
  verifyMembershipProof,
} from "../core/membership-proof.js";
import { loadOrCreateMachineIdentity } from "../core/machine-identity.js";
import { mintCapabilityToken } from "wire-mesh-core/domain/tokens";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { DEVICE_MEMBER_CAPABILITY } from "../core/device-membership-verification.js";
import { encodeTokenText } from "../core/token-text.js";
import { randomId } from "../core/random-id.js";

async function makeUser(): Promise<Awaited<ReturnType<typeof toIdentityPort>>> {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "membership-proof-user-"));
  return toIdentityPort(loadOrCreateUserIdentity({ dir }));
}

/** A real receiving node: its own device identity is what verification runs as. */
async function makeVerifier() {
  return {
    identity: await toIdentityPort(generateIdentity()),
    clock: createSystemClock(),
    revocation: createRevocationView(),
  };
}

describe("membership proof", () => {
  it("verifies for the device it was minted for, against the principal that minted it, and reports when it expires", async () => {
    const user = await makeUser();
    const device = await toIdentityPort(generateIdentity());
    const clock = createSystemClock();
    const before = clock.now();

    const proof = await mintMembershipProof({
      issuer: user,
      clock,
      deviceId: device.deviceId,
    });
    const verdict = await verifyMembershipProof({
      proof,
      deviceId: device.deviceId,
      issuerId: user.deviceId,
      ...(await makeVerifier()),
    });

    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.expires).toBeGreaterThan(before);
    expect(verdict.expires).toBeLessThanOrEqual(
      clock.now() + MEMBERSHIP_PROOF_LIFETIME_MS,
    );
  });

  it("is one line of text, so it can ride in a gossiped advert", async () => {
    const user = await makeUser();
    const device = await toIdentityPort(generateIdentity());

    const proof = await mintMembershipProof({
      issuer: user,
      clock: createSystemClock(),
      deviceId: device.deviceId,
    });

    expect(proof).toMatch(/^\S+$/);
  });

  it("does not verify for a different device, so a copied proof cannot vouch for anyone else", async () => {
    const user = await makeUser();
    const device = await toIdentityPort(generateIdentity());
    const other = await toIdentityPort(generateIdentity());

    const proof = await mintMembershipProof({
      issuer: user,
      clock: createSystemClock(),
      deviceId: device.deviceId,
    });
    const verdict = await verifyMembershipProof({
      proof,
      deviceId: other.deviceId,
      issuerId: user.deviceId,
      ...(await makeVerifier()),
    });

    expect(verdict.ok).toBe(false);
  });

  it("does not verify against a principal that did not mint it", async () => {
    const user = await makeUser();
    const stranger = await makeUser();
    const device = await toIdentityPort(generateIdentity());

    const proof = await mintMembershipProof({
      issuer: user,
      clock: createSystemClock(),
      deviceId: device.deviceId,
    });
    const verdict = await verifyMembershipProof({
      proof,
      deviceId: device.deviceId,
      issuerId: stranger.deviceId,
      ...(await makeVerifier()),
    });

    expect(verdict.ok).toBe(false);
  });

  it("does not verify once it has expired", async () => {
    const user = await makeUser();
    const device = await toIdentityPort(generateIdentity());
    const clock = createSystemClock();

    const proof = await mintMembershipProof({
      issuer: user,
      clock,
      deviceId: device.deviceId,
    });
    const verifier = await makeVerifier();
    const later = {
      now: () => clock.now() + MEMBERSHIP_PROOF_LIFETIME_MS + 1,
    };
    const verdict = await verifyMembershipProof({
      proof,
      deviceId: device.deviceId,
      issuerId: user.deviceId,
      ...verifier,
      clock: later,
    });

    expect(verdict.ok).toBe(false);
  });

  it("refuses proof text longer than any real proof, before spending any effort on it", async () => {
    const user = await makeUser();
    const device = await toIdentityPort(generateIdentity());

    const verdict = await verifyMembershipProof({
      proof: "a".repeat(MAX_MEMBERSHIP_PROOF_LENGTH + 1),
      deviceId: device.deviceId,
      issuerId: user.deviceId,
      ...(await makeVerifier()),
    });

    expect(verdict).toEqual({ ok: false, reason: "too_long" });
  });

  it("mints proofs comfortably inside the length limit", async () => {
    const user = await makeUser();
    const device = await toIdentityPort(generateIdentity());

    const proof = await mintMembershipProof({
      issuer: user,
      clock: createSystemClock(),
      deviceId: device.deviceId,
    });

    expect(proof.length).toBeLessThan(MAX_MEMBERSHIP_PROOF_LENGTH / 2);
  });

  it("does not verify text that is not a proof", async () => {
    const user = await makeUser();
    const device = await toIdentityPort(generateIdentity());

    const verdict = await verifyMembershipProof({
      proof: "not a proof",
      deviceId: device.deviceId,
      issuerId: user.deviceId,
      ...(await makeVerifier()),
    });

    expect(verdict.ok).toBe(false);
  });

  it("verifies a machine's proof exactly as it verifies a principal's, and not against the principal", async () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "membership-proof-host-"));
    const machine = await toIdentityPort(loadOrCreateMachineIdentity({ dir }));
    const user = await toIdentityPort(loadOrCreateUserIdentity({ dir }));
    const device = await toIdentityPort(generateIdentity());

    const proof = await mintMembershipProof({
      issuer: machine,
      clock: createSystemClock(),
      deviceId: device.deviceId,
    });
    const verifier = await makeVerifier();

    const asMachine = await verifyMembershipProof({
      proof,
      deviceId: device.deviceId,
      issuerId: machine.deviceId,
      ...verifier,
    });
    const asPrincipal = await verifyMembershipProof({
      proof,
      deviceId: device.deviceId,
      issuerId: user.deviceId,
      ...verifier,
    });

    expect(asMachine.ok).toBe(true);
    expect(asPrincipal).toEqual({ ok: false, reason: "wrong_scope_path" });
  });

  it("identifies the issuer a proof names without being told it beforehand", async () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "membership-proof-host-"));
    const machine = await toIdentityPort(loadOrCreateMachineIdentity({ dir }));
    const device = await toIdentityPort(generateIdentity());
    const proof = await mintMembershipProof({
      issuer: machine,
      clock: createSystemClock(),
      deviceId: device.deviceId,
    });

    const verdict = await identifyMembershipProofIssuer({
      proof,
      deviceId: device.deviceId,
      ...(await makeVerifier()),
    });

    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.issuerHex).toBe(deviceIdToHex(machine.deviceId));
  });

  it("does not identify a proof for a different device", async () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "membership-proof-host-"));
    const machine = await toIdentityPort(loadOrCreateMachineIdentity({ dir }));
    const device = await toIdentityPort(generateIdentity());
    const other = await toIdentityPort(generateIdentity());
    const proof = await mintMembershipProof({
      issuer: machine,
      clock: createSystemClock(),
      deviceId: device.deviceId,
    });

    const verdict = await identifyMembershipProofIssuer({
      proof,
      deviceId: other.deviceId,
      ...(await makeVerifier()),
    });

    expect(verdict.ok).toBe(false);
  });

  it("does not identify a proof whose named group is not the key that signed it", async () => {
    const impostor = await toIdentityPort(generateIdentity());
    const victim = await toIdentityPort(generateIdentity());
    const device = await toIdentityPort(generateIdentity());
    const clock = createSystemClock();
    const minted = await mintCapabilityToken({
      identity: impostor,
      clock,
      tokenId: randomId(),
      bearer: device.deviceId,
      capability: DEVICE_MEMBER_CAPABILITY,
      scope: { kind: "group", path: deviceIdToHex(victim.deviceId) },
      expires: clock.now() + MEMBERSHIP_PROOF_LIFETIME_MS,
      delegationsRemaining: 0,
    });
    if (!minted.ok) throw new Error(`mint failed: ${minted.reason}`);

    const verdict = await identifyMembershipProofIssuer({
      proof: encodeTokenText(minted.token),
      deviceId: device.deviceId,
      ...(await makeVerifier()),
    });

    expect(verdict).toEqual({ ok: false, reason: "wrong_chain_root" });
  });
});

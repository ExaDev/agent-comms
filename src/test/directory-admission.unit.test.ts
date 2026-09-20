/**
 * Unit tests for directory admission: which gossiped directory entries a gateway merges, given the trust it holds and the membership proofs the entries carry. The verifier is a stub, so what is under test is the admission policy: what is skipped, cached, bounded and survived, not the cryptography (membership-proof.unit.test.ts).
 */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deviceIdFromHex } from "wire-mesh-core/domain/device-id";
import type { DirectoryEntry } from "wire-mesh-core/domain/mesh-session";
import type { PeerAdvert } from "wire-mesh-core/generated/protocol";
import {
  MAX_VERIFICATIONS_PER_BATCH,
  NEGATIVE_VERDICT_TTL_MS,
  directoryAdmission,
} from "../core/directory-admission.js";
import { GatewayTrust } from "../core/gateway-trust.js";

/** A device-id is a 64-character lowercase hex SHA-256 digest. */
const DEVICE_ID_HEX_LENGTH = 64;
const ONE_HOUR_MS = 3_600_000;
const PRINCIPAL = "a".repeat(DEVICE_ID_HEX_LENGTH);
/** How many times over the per-batch verification budget a flood exceeds it. */
const FLOOD_FACTOR = 3;
const OTHER_PRINCIPAL = "b".repeat(DEVICE_ID_HEX_LENGTH);

/** A stable, valid device id for a label, so each test names its devices instead of numbering them. */
function deviceHex(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

/** An entry whose advert carries `proof` (when given) under agent/self. The cast stands in for the fields of a real advert this policy never reads. */
function entry(label: string, proof?: string): DirectoryEntry {
  const advert = {
    addresses: [],
    "snapshot-seconds": 1,
    "agent/self": proof === undefined ? {} : { membership: proof },
  } as unknown as PeerAdvert;
  return { device: deviceIdFromHex(deviceHex(label)), advert };
}

type Verify = NonNullable<
  Parameters<typeof directoryAdmission>[0]["verifyMembership"]
>;

function verifier(ok: boolean): ReturnType<typeof vi.fn<Verify>> {
  return vi.fn<Verify>(async () =>
    Promise.resolve(
      ok
        ? { ok: true, expires: Date.now() + ONE_HOUR_MS }
        : { ok: false, reason: "wrong_scope_path" },
    ),
  );
}

describe("directoryAdmission", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("admits a device trusted by id without looking at any proof", async () => {
    const trust = new GatewayTrust();
    trust.add(deviceHex("trusted-by-id"));
    const verifyMembership = verifier(true);

    const admitted = await directoryAdmission({
      gatewayTrust: trust,
      verifyMembership,
    })([entry("trusted-by-id", "proof")]);

    expect(admitted).toHaveLength(1);
    expect(verifyMembership).not.toHaveBeenCalled();
  });

  it("admits a trusted principal's own device without looking at any proof", async () => {
    const trust = new GatewayTrust();
    trust.addPrincipal(deviceHex("principal-own"));
    const verifyMembership = verifier(true);

    const admitted = await directoryAdmission({
      gatewayTrust: trust,
      verifyMembership,
    })([entry("principal-own")]);

    expect(admitted).toHaveLength(1);
    expect(verifyMembership).not.toHaveBeenCalled();
  });

  it("admits a device whose proof a trusted principal vouches for, and records it as a verified member", async () => {
    const trust = new GatewayTrust();
    trust.addPrincipal(PRINCIPAL);
    const verifyMembership = verifier(true);

    const admitted = await directoryAdmission({
      gatewayTrust: trust,
      verifyMembership,
    })([entry("vouched", "proof-a")]);

    expect(admitted).toHaveLength(1);
    expect(trust.isReachable(deviceHex("vouched"))).toBe(true);
    expect(trust.isTrusted(deviceHex("vouched"))).toBe(false);
  });

  it("tries each trusted principal in turn and stops at the one that vouches", async () => {
    const trust = new GatewayTrust();
    trust.addPrincipal(OTHER_PRINCIPAL);
    trust.addPrincipal(PRINCIPAL);
    const verifyMembership = vi.fn<Verify>(async (claim) =>
      Promise.resolve(
        claim.principalHex === PRINCIPAL
          ? { ok: true, expires: Date.now() + ONE_HOUR_MS }
          : { ok: false, reason: "wrong_scope_path" },
      ),
    );

    await directoryAdmission({ gatewayTrust: trust, verifyMembership })([
      entry("two-principals", "proof-a"),
    ]);

    expect(verifyMembership).toHaveBeenCalledTimes(2);
    expect(trust.listVerifiedMembers()).toEqual([
      { device: deviceHex("two-principals"), principal: PRINCIPAL },
    ]);
  });

  it("does not verify the same proof again while the device is still a verified member", async () => {
    const trust = new GatewayTrust();
    trust.addPrincipal(PRINCIPAL);
    const verifyMembership = verifier(true);
    const admit = directoryAdmission({ gatewayTrust: trust, verifyMembership });

    await admit([entry("same-proof", "proof-a")]);
    await admit([entry("same-proof", "proof-a")]);

    expect(verifyMembership).toHaveBeenCalledTimes(1);
  });

  it("verifies a device's new proof even while its old one is still good, so its trust is renewed before the old one lapses", async () => {
    const trust = new GatewayTrust();
    trust.addPrincipal(PRINCIPAL);
    const verifyMembership = verifier(true);
    const admit = directoryAdmission({ gatewayTrust: trust, verifyMembership });

    await admit([entry("renewed", "proof-a")]);
    await admit([entry("renewed", "proof-b")]);

    expect(verifyMembership).toHaveBeenCalledTimes(2);
  });

  it("refuses a device whose proof no trusted principal vouches for, and does not re-verify that proof for a while", async () => {
    vi.useFakeTimers();
    const trust = new GatewayTrust();
    trust.addPrincipal(PRINCIPAL);
    const verifyMembership = verifier(false);
    const admit = directoryAdmission({ gatewayTrust: trust, verifyMembership });

    expect(await admit([entry("refused", "bad")])).toEqual([]);
    expect(await admit([entry("refused", "bad")])).toEqual([]);
    expect(verifyMembership).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(NEGATIVE_VERDICT_TTL_MS + 1);
    await admit([entry("refused", "bad")]);

    expect(verifyMembership).toHaveBeenCalledTimes(2);
  });

  it("refuses a device with no proof, and never asks the verifier", async () => {
    const trust = new GatewayTrust();
    trust.addPrincipal(PRINCIPAL);
    const verifyMembership = verifier(true);

    const admitted = await directoryAdmission({
      gatewayTrust: trust,
      verifyMembership,
    })([entry("no-proof")]);

    expect(admitted).toEqual([]);
    expect(verifyMembership).not.toHaveBeenCalled();
  });

  it("refuses a proof when this side has no way to verify one", async () => {
    const trust = new GatewayTrust();
    trust.addPrincipal(PRINCIPAL);

    const admitted = await directoryAdmission({
      gatewayTrust: trust,
      verifyMembership: undefined,
    })([entry("no-verifier", "proof-a")]);

    expect(admitted).toEqual([]);
  });

  it("survives a principal the verifier throws on, and still tries the others", async () => {
    const trust = new GatewayTrust();
    trust.addPrincipal("not-a-device-id");
    trust.addPrincipal(PRINCIPAL);
    const verifyMembership = vi.fn<Verify>(async (claim) => {
      if (claim.principalHex === "not-a-device-id") {
        throw new Error("expected a 64-character lowercase hex string");
      }
      return Promise.resolve({ ok: true, expires: Date.now() + ONE_HOUR_MS });
    });

    const admitted = await directoryAdmission({
      gatewayTrust: trust,
      verifyMembership,
    })([entry("bad-principal", "proof-a")]);

    expect(admitted).toHaveLength(1);
  });

  it("survives a verifier that always throws, refusing the entry instead of rejecting", async () => {
    const trust = new GatewayTrust();
    trust.addPrincipal(PRINCIPAL);
    const verifyMembership = vi.fn<Verify>(async () =>
      Promise.reject(new Error("no identity set")),
    );

    await expect(
      directoryAdmission({ gatewayTrust: trust, verifyMembership })([
        entry("verifier-throws", "proof-a"),
      ]),
    ).resolves.toEqual([]);
  });

  it("verifies only a bounded number of new proofs per batch, so a flood of adverts costs a bounded amount of work", async () => {
    const trust = new GatewayTrust();
    trust.addPrincipal(PRINCIPAL);
    const verifyMembership = verifier(false);
    const flood = Array.from(
      { length: MAX_VERIFICATIONS_PER_BATCH * FLOOD_FACTOR },
      (_, index) => entry(`flood-${String(index)}`, `proof-${String(index)}`),
    );

    await directoryAdmission({ gatewayTrust: trust, verifyMembership })(flood);

    expect(verifyMembership).toHaveBeenCalledTimes(MAX_VERIFICATIONS_PER_BATCH);
  });

  it("still admits trusted devices in a batch that is otherwise a flood", async () => {
    const trust = new GatewayTrust();
    trust.addPrincipal(PRINCIPAL);
    trust.add(deviceHex("trusted-in-flood"));
    const flood = Array.from(
      { length: MAX_VERIFICATIONS_PER_BATCH * FLOOD_FACTOR },
      (_, index) => entry(`flood-${String(index)}`, `proof-${String(index)}`),
    );

    const admitted = await directoryAdmission({
      gatewayTrust: trust,
      verifyMembership: verifier(false),
    })([...flood, entry("trusted-in-flood")]);

    expect(admitted).toHaveLength(1);
  });
});

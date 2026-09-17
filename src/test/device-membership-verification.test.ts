/**
 * Unit tests for core/device-membership-verification: the group:member capability, its scope path derivation, and verifyDeviceMembership's own obligations on top of verifyCapabilityToken (obligation-shaped the same way room-token-verification.test.ts already covers room:member -- capability match, scope kind/path match, and chain root).
 */
import { webcrypto } from "node:crypto";
import { describe, it, expect } from "vitest";
import { createNodeIdentity } from "wire-mesh-core/adapters/node-identity";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import {
  mintCapabilityToken,
  mintRevocationEntry,
} from "wire-mesh-core/domain/tokens";
import { createRevocationView } from "wire-mesh-core/domain/revocation-view";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import type { Clock } from "wire-mesh-core/ports/clock";
import type { CapabilityToken } from "wire-mesh-core/generated/protocol";
import {
  DEVICE_MEMBER_CAPABILITY,
  userGroupPath,
  verifyDeviceMembership,
} from "../core/device-membership-verification.js";

const ES256 = -7;
const HOUR_MS = 3_600_000;

function buf(bytes: Uint8Array | ArrayLike<number>): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(bytes);
}

async function generateEs256Identity(): Promise<IdentityPort> {
  const keyPair = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKeyBytes = new Uint8Array(
    await webcrypto.subtle.exportKey("raw", keyPair.publicKey),
  );
  return createNodeIdentity(keyPair.privateKey, publicKeyBytes, ES256);
}

function fixedClock(atMs: number): Clock {
  return { now: () => atMs };
}

let issuedTokenIds = 0;
function nextTokenId(): Uint8Array<ArrayBuffer> {
  issuedTokenIds += 1;
  return buf([issuedTokenIds]);
}

const NOW_MS = 1_893_456_000_000;
const EXPIRES_MS = NOW_MS + HOUR_MS;

async function mintDeviceMemberToken(
  issuer: IdentityPort,
  bearer: IdentityPort,
  groupPath: string,
  tokenId: Uint8Array<ArrayBuffer> = nextTokenId(),
): Promise<CapabilityToken> {
  const verdict = await mintCapabilityToken({
    identity: issuer,
    clock: fixedClock(NOW_MS),
    tokenId,
    bearer: bearer.deviceId,
    capability: DEVICE_MEMBER_CAPABILITY,
    scope: { kind: "group", path: groupPath },
    expires: EXPIRES_MS,
    delegationsRemaining: 0,
  });
  if (!verdict.ok) throw new Error(`mint failed: ${verdict.reason}`);
  return verdict.token;
}

describe("DEVICE_MEMBER_CAPABILITY / userGroupPath", () => {
  it("is the registered group:member capability string", () => {
    expect(DEVICE_MEMBER_CAPABILITY).toBe("group:member");
  });

  it("derives the group path as the user principal's own device-id hex", async () => {
    const user = await generateEs256Identity();
    expect(userGroupPath(user.deviceId)).toBe(deviceIdToHex(user.deviceId));
  });
});

describe("verifyDeviceMembership", () => {
  it("accepts a token rooted at the user principal for that principal's own group", async () => {
    const user = await generateEs256Identity();
    const device = await generateEs256Identity();
    const groupPath = userGroupPath(user.deviceId);
    const token = await mintDeviceMemberToken(user, device, groupPath);

    const verdict = await verifyDeviceMembership(token, {
      identity: user,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      expectedBearer: device.deviceId,
      userDeviceId: user.deviceId,
    });

    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.claims.capability).toBe(DEVICE_MEMBER_CAPABILITY);
      expect(verdict.claims.scope).toEqual({ kind: "group", path: groupPath });
    }
  });

  it("refuses a token minted by someone other than the claimed user principal", async () => {
    const user = await generateEs256Identity();
    const impostor = await generateEs256Identity();
    const device = await generateEs256Identity();
    const groupPath = userGroupPath(user.deviceId);
    // Minted by the impostor, scoped to claim it is the user's own group -- rootIssuer is the impostor, not the user, and must be refused.
    const token = await mintDeviceMemberToken(impostor, device, groupPath);

    const verdict = await verifyDeviceMembership(token, {
      identity: user,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      expectedBearer: device.deviceId,
      userDeviceId: user.deviceId,
    });

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("wrong_chain_root");
  });

  it("refuses a token scoped to a different user's group", async () => {
    const user = await generateEs256Identity();
    const otherUser = await generateEs256Identity();
    const device = await generateEs256Identity();
    const token = await mintDeviceMemberToken(
      user,
      device,
      userGroupPath(otherUser.deviceId),
    );

    const verdict = await verifyDeviceMembership(token, {
      identity: user,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      expectedBearer: device.deviceId,
      userDeviceId: user.deviceId,
    });

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("wrong_scope_path");
  });

  it("refuses a token with an unrelated capability even when scope kind/path line up", async () => {
    const user = await generateEs256Identity();
    const device = await generateEs256Identity();
    const groupPath = userGroupPath(user.deviceId);
    const verdict1 = await mintCapabilityToken({
      identity: user,
      clock: fixedClock(NOW_MS),
      tokenId: nextTokenId(),
      bearer: device.deviceId,
      capability: "exec:pty",
      scope: { kind: "group", path: groupPath },
      expires: EXPIRES_MS,
    });
    if (!verdict1.ok) throw new Error(`mint failed: ${verdict1.reason}`);

    const verdict = await verifyDeviceMembership(verdict1.token, {
      identity: user,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      expectedBearer: device.deviceId,
      userDeviceId: user.deviceId,
    });

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("wrong_capability");
  });

  it("refuses a token with the right capability but the wrong scope kind", async () => {
    const user = await generateEs256Identity();
    const device = await generateEs256Identity();
    const verdict1 = await mintCapabilityToken({
      identity: user,
      clock: fixedClock(NOW_MS),
      tokenId: nextTokenId(),
      bearer: device.deviceId,
      capability: DEVICE_MEMBER_CAPABILITY,
      scope: { kind: "room", path: userGroupPath(user.deviceId) },
      expires: EXPIRES_MS,
    });
    if (!verdict1.ok) throw new Error(`mint failed: ${verdict1.reason}`);

    const verdict = await verifyDeviceMembership(verdict1.token, {
      identity: user,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      expectedBearer: device.deviceId,
      userDeviceId: user.deviceId,
    });

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("wrong_scope_kind");
  });

  it("refuses a token bearing a different device than the authenticated connection", async () => {
    const user = await generateEs256Identity();
    const device = await generateEs256Identity();
    const impostorDevice = await generateEs256Identity();
    const token = await mintDeviceMemberToken(
      user,
      device,
      userGroupPath(user.deviceId),
    );

    const verdict = await verifyDeviceMembership(token, {
      identity: user,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      expectedBearer: impostorDevice.deviceId,
      userDeviceId: user.deviceId,
    });

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("bearer_mismatch");
  });

  it("refuses an expired token", async () => {
    const user = await generateEs256Identity();
    const device = await generateEs256Identity();
    const token = await mintDeviceMemberToken(
      user,
      device,
      userGroupPath(user.deviceId),
    );

    const verdict = await verifyDeviceMembership(token, {
      identity: user,
      clock: fixedClock(EXPIRES_MS + HOUR_MS),
      revocation: createRevocationView(),
      expectedBearer: device.deviceId,
      userDeviceId: user.deviceId,
    });

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("expired");
  });

  it("refuses a revoked token", async () => {
    const user = await generateEs256Identity();
    const device = await generateEs256Identity();
    const tokenId = nextTokenId();
    const token = await mintDeviceMemberToken(
      user,
      device,
      userGroupPath(user.deviceId),
      tokenId,
    );

    const revocation = createRevocationView();
    const entry = await mintRevocationEntry({
      identity: user,
      tokenId,
      revokedAt: NOW_MS,
    });
    await revocation.record(entry, { identity: user });

    const verdict = await verifyDeviceMembership(token, {
      identity: user,
      clock: fixedClock(NOW_MS),
      revocation,
      expectedBearer: device.deviceId,
      userDeviceId: user.deviceId,
    });

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("revoked");
  });
});

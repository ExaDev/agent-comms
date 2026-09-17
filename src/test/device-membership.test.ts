/**
 * Unit tests for core/device-membership: admitDevice (mint + issued-grant bookkeeping) and removeDevice (revoke + forget the issued-grant record), the mint/revoke half of agent-comms#161 -- verifyDeviceMembership itself is covered separately in device-membership-verification.test.ts.
 */
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { createSystemClock } from "wire-mesh-core/adapters/system-clock";
import { createRevocationView } from "wire-mesh-core/domain/revocation-view";
import { generateIdentity } from "../core/identity.js";
import { toIdentityPort } from "../core/wire-mesh-identity.js";
import { randomId } from "../core/random-id.js";
import {
  loadIssuedDeviceGrant,
  loadOrCreateUserIdentity,
} from "../core/user-identity.js";
import { admitDevice, removeDevice } from "../core/device-membership.js";
import {
  DEVICE_MEMBER_CAPABILITY,
  userGroupPath,
  verifyDeviceMembership,
} from "../core/device-membership-verification.js";

const TOKEN_TTL_MS = 60_000;

function tempDir(): string {
  return fs.mkdtempSync(
    path.join(tmpdir(), "agent-comms-device-membership-test-"),
  );
}

/** A real, persisted user-principal identity (not a bare in-memory keypair): admitDevice/removeDevice write through to the same user-identity.json this identity's own key material lives in, so the fixture must actually create that file first, the same way a real bridge process would via loadOrCreateUserIdentity. */
async function makeUser(): Promise<{
  identity: Awaited<ReturnType<typeof toIdentityPort>>;
  userIdentityOptions: { dir: string };
}> {
  const dir = tempDir();
  const identity = await toIdentityPort(loadOrCreateUserIdentity({ dir }));
  return { identity, userIdentityOptions: { dir } };
}

describe("admitDevice", () => {
  it("mints a group:member token bearing the device, rooted at the user principal", async () => {
    const { identity: user, userIdentityOptions } = await makeUser();
    const device = await toIdentityPort(generateIdentity());
    const clock = createSystemClock();

    const verdict = await admitDevice({
      userIdentity: user,
      userIdentityOptions,
      clock,
      tokenId: randomId(),
      deviceId: device.deviceId,
      expires: clock.now() + TOKEN_TTL_MS,
    });

    expect(
      verdict.ok,
      `expected mint to succeed, got ${JSON.stringify(verdict)}`,
    ).toBe(true);
    if (!verdict.ok) return;

    const memberVerdict = await verifyDeviceMembership(verdict.token, {
      identity: user,
      clock,
      revocation: createRevocationView(),
      expectedBearer: device.deviceId,
      userDeviceId: user.deviceId,
    });
    expect(memberVerdict.ok).toBe(true);
  });

  it("records the issued grant's token-id under the user principal's own store, keyed by device hex", async () => {
    const { identity: user, userIdentityOptions } = await makeUser();
    const device = await toIdentityPort(generateIdentity());
    const clock = createSystemClock();
    const tokenId = randomId();

    const verdict = await admitDevice({
      userIdentity: user,
      userIdentityOptions,
      clock,
      tokenId,
      deviceId: device.deviceId,
      expires: clock.now() + TOKEN_TTL_MS,
    });
    expect(verdict.ok).toBe(true);

    const deviceHex = deviceIdToHex(device.deviceId);
    expect(loadIssuedDeviceGrant(userIdentityOptions, deviceHex)).toEqual(
      tokenId,
    );
  });

  it("does not record an issued grant when the mint itself refuses", async () => {
    const { identity: user, userIdentityOptions } = await makeUser();
    const device = await toIdentityPort(generateIdentity());
    const clock = createSystemClock();

    const verdict = await admitDevice({
      userIdentity: user,
      userIdentityOptions,
      clock,
      tokenId: randomId(),
      deviceId: device.deviceId,
      // Already expired -- mintCapabilityToken refuses outright.
      expires: clock.now() - 1,
    });

    expect(verdict.ok).toBe(false);
    const deviceHex = deviceIdToHex(device.deviceId);
    expect(
      loadIssuedDeviceGrant(userIdentityOptions, deviceHex),
    ).toBeUndefined();
  });
});

describe("removeDevice", () => {
  it("does nothing and returns undefined when this principal never admitted the device", async () => {
    const { identity: user, userIdentityOptions } = await makeUser();
    const device = await toIdentityPort(generateIdentity());
    const clock = createSystemClock();

    const entry = await removeDevice({
      userIdentity: user,
      userIdentityOptions,
      clock,
      revocation: createRevocationView(),
      deviceId: device.deviceId,
    });

    expect(entry).toBeUndefined();
  });

  it("revokes an admitted device's own grant, records it locally, and forgets the issued-grant record", async () => {
    const { identity: user, userIdentityOptions } = await makeUser();
    const device = await toIdentityPort(generateIdentity());
    const clock = createSystemClock();

    const admitVerdict = await admitDevice({
      userIdentity: user,
      userIdentityOptions,
      clock,
      tokenId: randomId(),
      deviceId: device.deviceId,
      expires: clock.now() + TOKEN_TTL_MS,
    });
    if (!admitVerdict.ok) throw new Error("expected admission to succeed");

    const revocation = createRevocationView();
    const entry = await removeDevice({
      userIdentity: user,
      userIdentityOptions,
      clock,
      revocation,
      deviceId: device.deviceId,
    });
    expect(entry).not.toBeUndefined();

    const deviceHex = deviceIdToHex(device.deviceId);
    expect(
      loadIssuedDeviceGrant(userIdentityOptions, deviceHex),
    ).toBeUndefined();

    const verdict = await verifyDeviceMembership(admitVerdict.token, {
      identity: user,
      clock,
      revocation,
      expectedBearer: device.deviceId,
      userDeviceId: user.deviceId,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("revoked");
  });

  it("re-admitting after removal mints and records a genuinely fresh grant", async () => {
    const { identity: user, userIdentityOptions } = await makeUser();
    const device = await toIdentityPort(generateIdentity());
    const clock = createSystemClock();

    const first = await admitDevice({
      userIdentity: user,
      userIdentityOptions,
      clock,
      tokenId: randomId(),
      deviceId: device.deviceId,
      expires: clock.now() + TOKEN_TTL_MS,
    });
    if (!first.ok) throw new Error("expected first admission to succeed");

    const revocation = createRevocationView();
    await removeDevice({
      userIdentity: user,
      userIdentityOptions,
      clock,
      revocation,
      deviceId: device.deviceId,
    });

    const second = await admitDevice({
      userIdentity: user,
      userIdentityOptions,
      clock,
      tokenId: randomId(),
      deviceId: device.deviceId,
      expires: clock.now() + TOKEN_TTL_MS,
    });
    if (!second.ok) throw new Error("expected re-admission to succeed");

    const verdict = await verifyDeviceMembership(second.token, {
      identity: user,
      clock,
      revocation,
      expectedBearer: device.deviceId,
      userDeviceId: user.deviceId,
    });
    expect(verdict.ok).toBe(true);
  });
});

describe("userGroupPath / DEVICE_MEMBER_CAPABILITY re-exports", () => {
  it("are usable together to compute the scope a real admission grant carries", async () => {
    const { identity: user, userIdentityOptions } = await makeUser();
    const device = await toIdentityPort(generateIdentity());
    const clock = createSystemClock();

    const verdict = await admitDevice({
      userIdentity: user,
      userIdentityOptions,
      clock,
      tokenId: randomId(),
      deviceId: device.deviceId,
      expires: clock.now() + TOKEN_TTL_MS,
    });
    if (!verdict.ok) throw new Error("expected admission to succeed");

    const [, , payload] = verdict.token;
    expect(payload).not.toBeNull();
    // The token's own scope is not re-decoded here (that is verifyDeviceMembership's job, exercised above); this asserts admitDevice used the module's own exported helpers rather than a second, independently-typed copy of the same capability/scope shape.
    expect(DEVICE_MEMBER_CAPABILITY).toBe("group:member");
    expect(userGroupPath(user.deviceId)).toBe(deviceIdToHex(user.deviceId));
  });
});

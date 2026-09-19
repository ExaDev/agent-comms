/**
 * Unit tests for core/dm-send-delegation: delegateDmSendToDevice, the primitive that lets a user principal already admitted into a remote user's DM-communication scope (room-lifecycle.ts's admitAgentForDm, minted with delegationsRemaining \> 0) sub-delegate that admission to one of its own devices (agent-comms#187) -- the dm:send counterpart to device-membership.test.ts's own admitDevice/removeDevice coverage.
 */
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { mintCapabilityToken } from "wire-mesh-core/domain/tokens";
import { createSystemClock } from "wire-mesh-core/adapters/system-clock";
import { createRevocationView } from "wire-mesh-core/domain/revocation-view";
import { generateIdentity } from "../core/identity.js";
import { toIdentityPort } from "../core/wire-mesh-identity.js";
import { randomId } from "../core/random-id.js";
import {
  loadIssuedDmGrant,
  loadOrCreateUserIdentity,
} from "../core/user-identity.js";
import {
  DM_SEND_CAPABILITY,
  DM_SEND_SCOPE_KIND,
  verifyDmSendToken,
} from "../core/dm-token-verification.js";
import { delegateDmSendToDevice } from "../core/dm-send-delegation.js";

const TOKEN_TTL_MS = 60_000;
const NON_DELEGABLE = 0;
const ONE_HOP_DELEGABLE = 1;

function tempDir(): string {
  return fs.mkdtempSync(path.join(tmpdir(), "agent-comms-dm-delegation-test-"));
}

/** A real, persisted user-principal identity -- delegateDmSendToDevice writes through to the same user-identity.json this identity's own key material lives in, so the fixture must actually create that file first, the same way device-membership.test.ts's own makeUser() does. */
async function makeUser(): Promise<{
  identity: Awaited<ReturnType<typeof toIdentityPort>>;
  userIdentityOptions: { dir: string };
}> {
  const dir = tempDir();
  const identity = await toIdentityPort(loadOrCreateUserIdentity({ dir }));
  return { identity, userIdentityOptions: { dir } };
}

/** Alice's own root-level dm:send grant naming bearer as the admitted party -- the same shape room-lifecycle.ts's admitAgentForDm mints, built directly here so this file's own tests don't need a full MeshStore. Takes an explicit expires (rather than deriving one from clock.now() itself) so a caller can mint a child token sharing the identical expiry -- a real wall clock advances between two calls, and a child's own expires must never exceed its parent's. */
async function mintRootGrant(options: {
  admitter: Awaited<ReturnType<typeof toIdentityPort>>;
  bearer: Awaited<ReturnType<typeof toIdentityPort>>["deviceId"];
  clock: Readonly<ReturnType<typeof createSystemClock>>;
  delegationsRemaining: number;
  expires: number;
}) {
  const { admitter, bearer, clock, delegationsRemaining, expires } = options;
  const verdict = await mintCapabilityToken({
    identity: admitter,
    clock,
    tokenId: randomId(),
    bearer,
    capability: DM_SEND_CAPABILITY,
    scope: { kind: DM_SEND_SCOPE_KIND, path: deviceIdToHex(admitter.deviceId) },
    expires,
    delegationsRemaining,
  });
  if (!verdict.ok) throw new Error("expected root grant to mint");
  return verdict.token;
}

describe("delegateDmSendToDevice", () => {
  it("mints a dm:send token bearing the device, chaining back to the remote admitting principal", async () => {
    const alice = await toIdentityPort(generateIdentity());
    const { identity: bobPrincipal, userIdentityOptions } = await makeUser();
    const bobDevice = await toIdentityPort(generateIdentity());
    const clock = createSystemClock();
    const expires = clock.now() + TOKEN_TTL_MS;

    const grant = await mintRootGrant({
      admitter: alice,
      bearer: bobPrincipal.deviceId,
      clock,
      delegationsRemaining: ONE_HOP_DELEGABLE,
      expires,
    });

    const verdict = await delegateDmSendToDevice({
      userIdentity: bobPrincipal,
      userIdentityOptions,
      clock,
      tokenId: randomId(),
      parent: grant,
      deviceId: bobDevice.deviceId,
      remoteUserPrincipalDeviceId: alice.deviceId,
      expires,
    });

    expect(
      verdict.ok,
      `expected delegation to succeed, got ${JSON.stringify(verdict)}`,
    ).toBe(true);
    if (!verdict.ok) return;

    const checked = await verifyDmSendToken(verdict.token, {
      identity: alice,
      clock,
      revocation: createRevocationView(),
      expectedBearer: bobDevice.deviceId,
      userPrincipalDeviceId: alice.deviceId,
    });
    expect(checked.ok, JSON.stringify(checked)).toBe(true);
  });

  it("records the delegated grant's token-id under the delegating principal's own store, keyed by device hex", async () => {
    const alice = await toIdentityPort(generateIdentity());
    const { identity: bobPrincipal, userIdentityOptions } = await makeUser();
    const bobDevice = await toIdentityPort(generateIdentity());
    const clock = createSystemClock();
    const tokenId = randomId();
    const expires = clock.now() + TOKEN_TTL_MS;

    const grant = await mintRootGrant({
      admitter: alice,
      bearer: bobPrincipal.deviceId,
      clock,
      delegationsRemaining: ONE_HOP_DELEGABLE,
      expires,
    });

    const verdict = await delegateDmSendToDevice({
      userIdentity: bobPrincipal,
      userIdentityOptions,
      clock,
      tokenId,
      parent: grant,
      deviceId: bobDevice.deviceId,
      remoteUserPrincipalDeviceId: alice.deviceId,
      expires,
    });
    expect(verdict.ok).toBe(true);

    const deviceHex = deviceIdToHex(bobDevice.deviceId);
    expect(loadIssuedDmGrant(userIdentityOptions, deviceHex)).toEqual(tokenId);
  });

  it("refuses when the parent grant carries no further delegation depth, and records nothing", async () => {
    const alice = await toIdentityPort(generateIdentity());
    const { identity: bobPrincipal, userIdentityOptions } = await makeUser();
    const bobDevice = await toIdentityPort(generateIdentity());
    const clock = createSystemClock();
    const expires = clock.now() + TOKEN_TTL_MS;

    // The original, non-delegable admission -- exactly what admitAgentForDm mints by default.
    const grant = await mintRootGrant({
      admitter: alice,
      bearer: bobPrincipal.deviceId,
      clock,
      delegationsRemaining: NON_DELEGABLE,
      expires,
    });

    const verdict = await delegateDmSendToDevice({
      userIdentity: bobPrincipal,
      userIdentityOptions,
      clock,
      tokenId: randomId(),
      parent: grant,
      deviceId: bobDevice.deviceId,
      remoteUserPrincipalDeviceId: alice.deviceId,
      expires,
    });

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("delegation_exceeds_parent");
    const deviceHex = deviceIdToHex(bobDevice.deviceId);
    expect(loadIssuedDmGrant(userIdentityOptions, deviceHex)).toBeUndefined();
  });

  it("refuses when the caller's identity is not the parent grant's own bearer", async () => {
    const alice = await toIdentityPort(generateIdentity());
    const { identity: bobPrincipal, userIdentityOptions } = await makeUser();
    const someoneElse = await toIdentityPort(generateIdentity());
    const bobDevice = await toIdentityPort(generateIdentity());
    const clock = createSystemClock();
    const expires = clock.now() + TOKEN_TTL_MS;

    const grant = await mintRootGrant({
      admitter: alice,
      bearer: bobPrincipal.deviceId,
      clock,
      delegationsRemaining: ONE_HOP_DELEGABLE,
      expires,
    });

    const verdict = await delegateDmSendToDevice({
      // someoneElse never received this grant -- only bobPrincipal (the parent's own bearer) may mint a delegation of it.
      userIdentity: someoneElse,
      userIdentityOptions,
      clock,
      tokenId: randomId(),
      parent: grant,
      deviceId: bobDevice.deviceId,
      remoteUserPrincipalDeviceId: alice.deviceId,
      expires,
    });

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("parent_bearer_mismatch");
  });
});

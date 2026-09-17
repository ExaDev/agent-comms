/**
 * Unit tests for verifyDmSendToken (agent-comms#162): the receiver-side check that a presented capability token genuinely proves the local user principal admitted its bearer into DM contact -- mirroring room-token-verification.test.ts's own coverage of verifyRoomToken, but rooted at a user principal rather than a room owner.
 */

import { test, expect } from "vitest";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { mintCapabilityToken } from "wire-mesh-core/domain/tokens";
import { createSystemClock } from "wire-mesh-core/adapters/system-clock";
import {
  DM_SEND_CAPABILITY,
  verifyDmSendToken,
} from "../core/dm-token-verification.js";
import { generateIdentity } from "../core/identity.js";
import { toIdentityPort } from "../core/wire-mesh-identity.js";
import { randomId } from "../core/random-id.js";

const TOKEN_TTL_MS = 60_000;

async function makeParties() {
  const userPrincipal = await toIdentityPort(generateIdentity());
  const bearer = await toIdentityPort(generateIdentity());
  const stranger = await toIdentityPort(generateIdentity());
  const clock = createSystemClock();
  const revocation = { entriesFor: async () => [] };
  return { userPrincipal, bearer, stranger, clock, revocation };
}

test("a dm:send token minted by the user principal, scoped to itself, verifies", async () => {
  const { userPrincipal, bearer, clock, revocation } = await makeParties();

  const verdict = await mintCapabilityToken({
    identity: userPrincipal,
    clock,
    tokenId: randomId(),
    bearer: bearer.deviceId,
    capability: DM_SEND_CAPABILITY,
    scope: { kind: "user", path: deviceIdToHex(userPrincipal.deviceId) },
    expires: clock.now() + TOKEN_TTL_MS,
    delegationsRemaining: 0,
  });
  expect(verdict.ok).toBe(true);
  if (!verdict.ok) return;

  const result = await verifyDmSendToken(verdict.token, {
    identity: bearer,
    clock,
    revocation,
    expectedBearer: bearer.deviceId,
    userPrincipalDeviceId: userPrincipal.deviceId,
  });

  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  expect(result.claims.capability).toBe(DM_SEND_CAPABILITY);
});

test("a token for a different capability is refused as wrong_capability", async () => {
  const { userPrincipal, bearer, clock, revocation } = await makeParties();

  const verdict = await mintCapabilityToken({
    identity: userPrincipal,
    clock,
    tokenId: randomId(),
    bearer: bearer.deviceId,
    capability: "room:member",
    scope: { kind: "user", path: deviceIdToHex(userPrincipal.deviceId) },
    expires: clock.now() + TOKEN_TTL_MS,
    delegationsRemaining: 0,
  });
  if (!verdict.ok) throw new Error("mint failed");

  const result = await verifyDmSendToken(verdict.token, {
    identity: bearer,
    clock,
    revocation,
    expectedBearer: bearer.deviceId,
    userPrincipalDeviceId: userPrincipal.deviceId,
  });

  expect(result).toEqual({ ok: false, reason: "wrong_capability" });
});

test("a token scoped to the wrong kind is refused as wrong_scope_kind", async () => {
  const { userPrincipal, bearer, clock, revocation } = await makeParties();

  const verdict = await mintCapabilityToken({
    identity: userPrincipal,
    clock,
    tokenId: randomId(),
    bearer: bearer.deviceId,
    capability: DM_SEND_CAPABILITY,
    scope: { kind: "room", path: deviceIdToHex(userPrincipal.deviceId) },
    expires: clock.now() + TOKEN_TTL_MS,
    delegationsRemaining: 0,
  });
  if (!verdict.ok) throw new Error("mint failed");

  const result = await verifyDmSendToken(verdict.token, {
    identity: bearer,
    clock,
    revocation,
    expectedBearer: bearer.deviceId,
    userPrincipalDeviceId: userPrincipal.deviceId,
  });

  expect(result).toEqual({ ok: false, reason: "wrong_scope_kind" });
});

test("a token scoped to a different user principal is refused as wrong_scope_path", async () => {
  const { userPrincipal, bearer, stranger, clock, revocation } =
    await makeParties();

  const verdict = await mintCapabilityToken({
    identity: userPrincipal,
    clock,
    tokenId: randomId(),
    bearer: bearer.deviceId,
    capability: DM_SEND_CAPABILITY,
    scope: { kind: "user", path: deviceIdToHex(stranger.deviceId) },
    expires: clock.now() + TOKEN_TTL_MS,
    delegationsRemaining: 0,
  });
  if (!verdict.ok) throw new Error("mint failed");

  const result = await verifyDmSendToken(verdict.token, {
    identity: bearer,
    clock,
    revocation,
    expectedBearer: bearer.deviceId,
    userPrincipalDeviceId: userPrincipal.deviceId,
  });

  expect(result).toEqual({ ok: false, reason: "wrong_scope_path" });
});

test("a self-issued token naming the right scope by coincidence is refused as wrong_chain_root", async () => {
  const { userPrincipal, bearer, clock, revocation } = await makeParties();

  // The bearer mints its own token, claiming the user principal's own scope path -- proving scope.path alone is never sufficient; the chain must actually root at the user principal's own issuing key.
  const verdict = await mintCapabilityToken({
    identity: bearer,
    clock,
    tokenId: randomId(),
    bearer: bearer.deviceId,
    capability: DM_SEND_CAPABILITY,
    scope: { kind: "user", path: deviceIdToHex(userPrincipal.deviceId) },
    expires: clock.now() + TOKEN_TTL_MS,
    delegationsRemaining: 0,
  });
  if (!verdict.ok) throw new Error("mint failed");

  const result = await verifyDmSendToken(verdict.token, {
    identity: bearer,
    clock,
    revocation,
    expectedBearer: bearer.deviceId,
    userPrincipalDeviceId: userPrincipal.deviceId,
  });

  expect(result).toEqual({ ok: false, reason: "wrong_chain_root" });
});

test("a token presented by a different bearer than it names is refused (bearer_mismatch, from verifyCapabilityToken)", async () => {
  const { userPrincipal, bearer, stranger, clock, revocation } =
    await makeParties();

  const verdict = await mintCapabilityToken({
    identity: userPrincipal,
    clock,
    tokenId: randomId(),
    bearer: bearer.deviceId,
    capability: DM_SEND_CAPABILITY,
    scope: { kind: "user", path: deviceIdToHex(userPrincipal.deviceId) },
    expires: clock.now() + TOKEN_TTL_MS,
    delegationsRemaining: 0,
  });
  if (!verdict.ok) throw new Error("mint failed");

  const result = await verifyDmSendToken(verdict.token, {
    identity: bearer,
    clock,
    revocation,
    expectedBearer: stranger.deviceId,
    userPrincipalDeviceId: userPrincipal.deviceId,
  });

  expect(result).toEqual({ ok: false, reason: "bearer_mismatch" });
});

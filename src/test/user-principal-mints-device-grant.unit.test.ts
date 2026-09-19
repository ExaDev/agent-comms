/**
 * The user principal (agent-comms#160) must be a genuine issuer: it must be able to mint a capability token bearing a device it owns, and that token must verify with the principal's own device-id as rootIssuer, exactly as any other issuer's root grant already does (see create-room-mints-owner-grant.test.ts for the room-owner equivalent). This is the concrete proof the issue asks for -- a persisted identity object alone would not demonstrate it can actually issue.
 *
 * The capability/scope minted here (`room:member`, scope kind `group`) is a syntactically valid probe only, borrowed from the one capability string already proven to mint and verify elsewhere in this codebase -- the real device-to-user membership grant shape (what capability and scope a device actually presents to prove "the user principal admitted me") is agent-comms#161's own scope, deliberately not decided here.
 */

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect } from "vitest";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import {
  mintCapabilityToken,
  verifyCapabilityToken,
} from "wire-mesh-core/domain/tokens";
import { createSystemClock } from "wire-mesh-core/adapters/system-clock";
import { loadOrCreateUserIdentity } from "../core/user-identity.js";
import { generateIdentity } from "../core/identity.js";
import { toIdentityPort } from "../core/wire-mesh-identity.js";
import { randomId } from "../core/random-id.js";

/** The probe grant's expiry window. */
const TOKEN_TTL_MS = 60_000;

function tempDir(): string {
  return fs.mkdtempSync(
    path.join(tmpdir(), "agent-comms-user-principal-mint-test-"),
  );
}

test("the user principal mints a capability token bearing a device it owns", async () => {
  const userIdentity = await toIdentityPort(
    loadOrCreateUserIdentity({ dir: tempDir() }),
  );
  const device = await toIdentityPort(generateIdentity());
  const clock = createSystemClock();

  const verdict = await mintCapabilityToken({
    identity: userIdentity,
    clock,
    tokenId: randomId(),
    bearer: device.deviceId,
    capability: "room:member",
    scope: { kind: "group", path: deviceIdToHex(userIdentity.deviceId) },
    expires: clock.now() + TOKEN_TTL_MS,
    delegationsRemaining: 0,
  });

  expect(
    verdict.ok,
    `expected the user principal's mint to succeed, got ${JSON.stringify(verdict)}`,
  ).toBe(true);
  if (!verdict.ok) return;

  // Any IdentityPort supplies verification-only crypto primitives -- verifyCapabilityToken never trusts the caller's own identity, only the token's self-certifying issuer-key, so a throwaway identity works here exactly as well as the principal's real one.
  const verifierIdentity = await toIdentityPort(generateIdentity());
  const result = await verifyCapabilityToken(verdict.token, {
    identity: verifierIdentity,
    clock,
    revocation: { entriesFor: async () => [] },
    expectedBearer: device.deviceId,
  });

  expect(
    result.ok,
    `expected the principal's grant to verify, got ${JSON.stringify(result)}`,
  ).toBe(true);
  if (!result.ok) return;
  expect(result.claims.capability).toBe("room:member");
  expect(result.claims.scope).toEqual({
    kind: "group",
    path: deviceIdToHex(userIdentity.deviceId),
  });
  expect(result.rootIssuer).toEqual(userIdentity.deviceId);
  expect(deviceIdToHex(result.rootIssuer)).toBe(
    deviceIdToHex(userIdentity.deviceId),
  );
});

test("the user principal's own device-id is stable across separate loads of the same directory", async () => {
  const dir = tempDir();
  const first = await toIdentityPort(loadOrCreateUserIdentity({ dir }));
  const second = await toIdentityPort(loadOrCreateUserIdentity({ dir }));

  expect(deviceIdToHex(second.deviceId)).toBe(deviceIdToHex(first.deviceId));
});

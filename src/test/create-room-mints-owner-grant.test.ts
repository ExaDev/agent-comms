/**
 * createRoom must mint and persist the owner's own self-signed room:member grant, so the owner has a token to present for its own room actions uniformly with every other member (rather than being implicitly exempt from the check every other member's actions go through).
 */

import * as assert from "node:assert/strict";
import { test } from "node:test";
import { deviceIdFromHex } from "wire-mesh-core/domain/device-id";
import { verifyCapabilityToken } from "wire-mesh-core/domain/tokens";
import { createSystemClock } from "wire-mesh-core/adapters/system-clock";
import { MeshStore } from "../core/mesh-store.js";
import { loadRoomTokens } from "../core/identity-store.js";
import type { IdentitySlot } from "../core/identity-store.js";
import { generateIdentity } from "../core/identity.js";
import { toIdentityPort } from "../core/wire-mesh-identity.js";
import { wireTestTransport } from "./test-transport.js";

async function makeStore(): Promise<{ store: MeshStore; slot: IdentitySlot }> {
  const store = new MeshStore();
  const slot = await wireTestTransport(store);
  return { store, slot };
}

void test("createRoom persists a self-signed room:member grant for the owner", async () => {
  const { store, slot } = await makeStore();
  const owner = await store.registerAgent({
    name: "owner",
    harness: "pi",
    cwd: "/tmp/p",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });

  const room = await store.createRoom({
    name: "general",
    type: "public",
    owner: owner.id,
    description: "",
  });

  const tokens = loadRoomTokens(slot);
  const token = tokens[room.id];
  assert.ok(token !== undefined, "expected a persisted token for the new room");

  // Any IdentityPort supplies verification-only crypto primitives -- verifyCapabilityToken never trusts the caller's own identity, only the token's self-certifying issuer-key, so a throwaway identity works here exactly as well as the owner's real one.
  const verifierIdentity = await toIdentityPort(generateIdentity());
  const verdict = await verifyCapabilityToken(token, {
    identity: verifierIdentity,
    clock: createSystemClock(),
    revocation: { isRevoked: async () => false },
    expectedBearer: deviceIdFromHex(owner.id),
  });

  assert.ok(
    verdict.ok,
    `expected the owner grant to verify, got ${JSON.stringify(verdict)}`,
  );
  if (!verdict.ok) return;
  assert.equal(verdict.claims.capability, "room:member");
  assert.deepEqual(verdict.claims.scope, { kind: "room", path: room.id });
  assert.deepEqual(verdict.rootIssuer, deviceIdFromHex(owner.id));
});

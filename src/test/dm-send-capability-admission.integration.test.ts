/**
 * Integration test for receiver-side DM gating with a user-issued capability (agent-comms#162): a receiver's own user principal can admit an agent into its DM-communication scope by minting a dm:send grant, which the agent then presents alongside its DM join request to auto-admit without needing a fresh human decision each time -- the durable admission list this issue adds, distinct from (and additive to) dm-admission.integration.test.ts's own two-round human-consent flow, which remains the fallback when no dm:send grant is presented at all.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { test, expect } from "vitest";
import {
  deviceIdFromHex,
  deviceIdToHex,
} from "wire-mesh-core/domain/device-id";
import { mintCapabilityToken } from "wire-mesh-core/domain/tokens";
import { createSystemClock } from "wire-mesh-core/adapters/system-clock";
import { MeshStore } from "../core/mesh-store.js";
import { generateIdentity } from "../core/identity.js";
import { toIdentityPort } from "../core/wire-mesh-identity.js";
import { randomId } from "../core/random-id.js";
import { loadOrCreateUserIdentity } from "../core/user-identity.js";
import { DM_SEND_CAPABILITY } from "../core/dm-token-verification.js";
import { waitFor, wireTestTransport } from "./test-transport.js";

/** A device-id, hex-encoded, is always exactly this many characters (32 raw bytes). */
const DEVICE_ID_HEX_LENGTH = 64;

/** Expiry window for a delegated dm:send token minted directly in these tests (agent-comms#187) -- comfortably longer than any single test run, matching device-membership.test.ts's own TOKEN_TTL_MS convention. */
const DELEGATED_TOKEN_TTL_MS = 60_000;

let nextPort = 20_990;
function freshPort(): number {
  nextPort += 1;
  return nextPort;
}

async function makeConnectedPair(
  port: number,
): Promise<{ a: MeshStore; b: MeshStore }> {
  const a = new MeshStore(port);
  await wireTestTransport(a);
  await a.init();
  await a.registerAgent({
    name: "a",
    harness: "test",
    cwd: "/test/a",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });

  const b = new MeshStore(port);
  await wireTestTransport(b);
  await b.init();
  await b.registerAgent({
    name: "b",
    harness: "test",
    cwd: "/test/b",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });

  await waitFor(
    () => a.serialise().agents[b.peerId] !== undefined,
    "a sees b's agent",
  );
  return { a, b };
}

test("presenting a dm:send grant B minted for A auto-admits A's DM request, with no pending decision for B", async () => {
  const { a, b } = await makeConnectedPair(freshPort());

  try {
    const grant = await b.admitAgentForDm(a.peerId);

    await a.requestDmAccess(b.peerId, grant);

    expect(b.listPendingRoomJoins()).toEqual([]);
    expect(a.listPendingRoomJoins()).toEqual([]);
  } finally {
    await b.shutdown();
    await a.shutdown();
  }
});

test("presenting a grant minted for a different bearer is refused outright, with no pending decision left open", async () => {
  const { a, b } = await makeConnectedPair(freshPort());

  try {
    // B admits some other device, never A -- A tries to present that grant as if it were its own.
    const otherDeviceId = deviceIdFromHex("a".repeat(DEVICE_ID_HEX_LENGTH));
    const grantForSomeoneElse = await b.admitAgentForDm(
      Buffer.from(otherDeviceId).toString("hex"),
    );

    await expect(
      a.requestDmAccess(b.peerId, grantForSomeoneElse),
    ).rejects.toThrow(/was refused/);

    expect(b.listPendingRoomJoins()).toEqual([]);
  } finally {
    await b.shutdown();
    await a.shutdown();
  }
});

test("after B revokes A's dm:send grant, presenting the stale token is refused", async () => {
  const { a, b } = await makeConnectedPair(freshPort());

  try {
    const grant = await b.admitAgentForDm(a.peerId);
    await b.revokeAgentDmAccess(a.peerId);

    await expect(a.requestDmAccess(b.peerId, grant)).rejects.toThrow(
      /was refused/,
    );
  } finally {
    await b.shutdown();
    await a.shutdown();
  }
});

test("revoking a bearer that was never admitted is a harmless no-op", async () => {
  const { a, b } = await makeConnectedPair(freshPort());

  try {
    await expect(b.revokeAgentDmAccess(a.peerId)).resolves.toBeUndefined();
  } finally {
    await b.shutdown();
    await a.shutdown();
  }
});

/** B's own user-principal identity, loaded from a directory this test controls directly (rather than the throwaway one wireTestTransport would otherwise generate internally and never disclose), so a test can compute the exact "user" scope path (B's own principal device-id, hex) a dm:send grant B mints is rooted at -- agent-comms#187's own principal-keyed admission tests need this to construct a further delegation whose scope actually narrows the grant it chains from. */
function tempUserIdentityDir(): { dir: string } {
  return {
    dir: fs.mkdtempSync(
      path.join(tmpdir(), "agent-comms-b-user-identity-test-"),
    ),
  };
}

test("admitting a bearer with a positive delegationsRemaining lets that bearer itself mint a further dm:send delegation (agent-comms#187)", async () => {
  const bUserIdentityOptions = tempUserIdentityDir();
  const bPrincipalHex = deviceIdToHex(
    (await toIdentityPort(loadOrCreateUserIdentity(bUserIdentityOptions)))
      .deviceId,
  );
  const clock = createSystemClock();

  const b = new MeshStore(freshPort());
  await wireTestTransport(
    b,
    undefined,
    undefined,
    undefined,
    bUserIdentityOptions,
  );
  await b.init();

  try {
    // The admitted bearer is a real principal identity here, not just a bare hex string -- only the entity actually holding bearerId's own key can mint a delegation of the grant, since mintCapabilityToken's own parent-narrowing requires the child's issuer to equal the parent's bearer.
    const principal = await toIdentityPort(generateIdentity());
    const bearerHex = deviceIdToHex(principal.deviceId);

    const grant = await b.admitAgentForDm(bearerHex, 1);

    const device = await toIdentityPort(generateIdentity());
    const delegated = await mintCapabilityToken({
      identity: principal,
      clock,
      tokenId: randomId(),
      bearer: device.deviceId,
      capability: DM_SEND_CAPABILITY,
      scope: { kind: "user", path: bPrincipalHex },
      expires: clock.now() + DELEGATED_TOKEN_TTL_MS,
      delegationsRemaining: 0,
      parent: grant,
    });

    expect(
      delegated.ok,
      `expected the delegation to succeed, got ${JSON.stringify(delegated)}`,
    ).toBe(true);
  } finally {
    await b.shutdown();
  }
});

test("admitting a bearer with no delegationsRemaining given stays non-delegable, exactly like the existing bare-device path", async () => {
  const bUserIdentityOptions = tempUserIdentityDir();
  const bPrincipalHex = deviceIdToHex(
    (await toIdentityPort(loadOrCreateUserIdentity(bUserIdentityOptions)))
      .deviceId,
  );
  const clock = createSystemClock();

  const b = new MeshStore(freshPort());
  await wireTestTransport(
    b,
    undefined,
    undefined,
    undefined,
    bUserIdentityOptions,
  );
  await b.init();

  try {
    const principal = await toIdentityPort(generateIdentity());
    const bearerHex = deviceIdToHex(principal.deviceId);

    const grant = await b.admitAgentForDm(bearerHex);

    const device = await toIdentityPort(generateIdentity());
    const delegated = await mintCapabilityToken({
      identity: principal,
      clock,
      tokenId: randomId(),
      bearer: device.deviceId,
      capability: DM_SEND_CAPABILITY,
      scope: { kind: "user", path: bPrincipalHex },
      expires: clock.now() + DELEGATED_TOKEN_TTL_MS,
      delegationsRemaining: 0,
      parent: grant,
    });

    expect(delegated.ok).toBe(false);
    if (!delegated.ok)
      expect(delegated.reason).toBe("delegation_exceeds_parent");
  } finally {
    await b.shutdown();
  }
});

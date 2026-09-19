/**
 * End-to-end integration test for agent-comms#187: a user principal admitted into another user's DM-communication scope with room delegation depth (admitAgentForDm) mints, via delegateDmSendToDevice, a further dm:send token naming one of its own devices as bearer -- and that device's own requestDmAccess, presenting only the delegated token, auto-admits exactly the way a directly-admitted bare device already does in dm-send-capability-admission.integration.test.ts. Proves the full "trust this whole person, not just one of their devices" flow the issue names, end to end over a real wire connection.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { test, expect } from "vitest";
import {
  deviceIdFromHex,
  deviceIdToHex,
} from "wire-mesh-core/domain/device-id";
import { createSystemClock } from "wire-mesh-core/adapters/system-clock";
import { MeshStore } from "../core/mesh-store.js";
import { loadOrCreateUserIdentity } from "../core/user-identity.js";
import { toIdentityPort } from "../core/wire-mesh-identity.js";
import { randomId } from "../core/random-id.js";
import { delegateDmSendToDevice } from "../core/dm-send-delegation.js";
import { waitFor, wireTestTransport } from "./test-transport.js";

/** Delegated token expiry -- comfortably longer than a single test run, matching this file's sibling integration tests' own convention. */
const DELEGATED_TOKEN_TTL_MS = 60_000;
/** The admitted principal keeps exactly one further hop of delegation depth, enough to reach one of its own devices -- the minimal case the issue itself describes ("sub-delegate to its own devices"). */
const ONE_HOP_DELEGABLE = 1;

let nextPort = 20_970;
function freshPort(): number {
  nextPort += 1;
  return nextPort;
}

function tempUserIdentityDir(): { dir: string } {
  return {
    dir: fs.mkdtempSync(
      path.join(tmpdir(), "agent-comms-principal-delegation-test-"),
    ),
  };
}

test("a principal's own device, holding only a delegated dm:send token, auto-admits into the admitting user's DM scope", async () => {
  const port = freshPort();

  // Alice's own user-principal identity is controlled directly (not the throwaway one wireTestTransport would otherwise generate and never disclose), so this test can compute the exact "user" scope path a delegated token must keep naming.
  const aliceUserIdentityOptions = tempUserIdentityDir();
  const alicePrincipal = await toIdentityPort(
    loadOrCreateUserIdentity(aliceUserIdentityOptions),
  );

  const a = new MeshStore({ coordinatorPort: port });
  await wireTestTransport(a, { userIdentityOptions: aliceUserIdentityOptions });
  await a.init();
  await a.registerAgent({
    name: "alice",
    harness: "test",
    cwd: "/test/alice",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });

  // Bob's own user-principal identity -- distinct from any bridge-slot device identity, and distinct from any of Bob's own devices below.
  const bobUserIdentityOptions = tempUserIdentityDir();
  const bobPrincipal = await toIdentityPort(
    loadOrCreateUserIdentity(bobUserIdentityOptions),
  );

  // One of Bob's own devices -- an ordinary bridge slot, wired and connected to Alice exactly like any other peer.
  const d = new MeshStore({ coordinatorPort: port });
  await wireTestTransport(d);
  await d.init();
  await d.registerAgent({
    name: "bobs-device",
    harness: "test",
    cwd: "/test/bobs-device",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });

  await waitFor(
    () => a.serialise().agents[d.peerId] !== undefined,
    "alice sees bob's device",
  );

  try {
    // Alice trusts Bob's own principal -- not this specific device -- with enough delegation depth for Bob to admit his own devices.
    const grant = await a.admitAgentForDm(
      deviceIdToHex(bobPrincipal.deviceId),
      ONE_HOP_DELEGABLE,
    );

    // Bob's principal delegates that admission to this one device, out of band from Alice entirely -- Alice never learns this device's own device-id in advance.
    const clock = createSystemClock();
    const delegated = await delegateDmSendToDevice({
      userIdentity: bobPrincipal,
      userIdentityOptions: bobUserIdentityOptions,
      clock,
      tokenId: randomId(),
      parent: grant,
      deviceId: deviceIdFromHex(d.peerId),
      remoteUserPrincipalDeviceId: alicePrincipal.deviceId,
      expires: clock.now() + DELEGATED_TOKEN_TTL_MS,
    });
    expect(
      delegated.ok,
      `expected the delegation to succeed, got ${JSON.stringify(delegated)}`,
    ).toBe(true);
    if (!delegated.ok) return;

    await d.requestDmAccess(a.peerId, delegated.token);

    expect(a.listPendingRoomJoins()).toEqual([]);
    expect(d.listPendingRoomJoins()).toEqual([]);
  } finally {
    await d.shutdown();
    await a.shutdown();
  }
});

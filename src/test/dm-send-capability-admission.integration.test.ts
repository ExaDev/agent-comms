/**
 * Integration test for receiver-side DM gating with a user-issued capability (agent-comms#162): a receiver's own user principal can admit an agent into its DM-communication scope by minting a dm:send grant, which the agent then presents alongside its DM join request to auto-admit without needing a fresh human decision each time -- the durable admission list this issue adds, distinct from (and additive to) dm-admission.integration.test.ts's own two-round human-consent flow, which remains the fallback when no dm:send grant is presented at all.
 */

import { test, expect } from "vitest";
import { deviceIdFromHex } from "wire-mesh-core/domain/device-id";
import { MeshStore } from "../core/mesh-store.js";
import { waitFor, wireTestTransport } from "./test-transport.js";

/** A device-id, hex-encoded, is always exactly this many characters (32 raw bytes). */
const DEVICE_ID_HEX_LENGTH = 64;

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

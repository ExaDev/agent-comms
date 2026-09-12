/**
 * Integration test for room.send's directed delivery (P3.5's own foundational primitive): a real, wire-authenticated room:member token authorises exactly one message to exactly one member's own session, verified against all six of core/room's obligations on the receiving end, delivered locally with no separate "delivered" event since the manage-response itself is the receipt.
 *
 * Membership is set up by minting and persisting the member's own token directly, not by driving a real room.join round trip: MeshStore's legacy full-state-sync (still active per the "both paths coexist" transition) makes two mesh-connected peers instantly aware of any room the moment it's created, so member.joinRoom(room.id, ...) always takes the already-known-locally branch rather than the wire-level remote-join path -- the same race #73's own tests had to route around, and irrelevant to what this file actually tests (room.send, not room.join).
 */

import * as assert from "node:assert/strict";
import { test } from "node:test";
import { mintCapabilityToken } from "wire-mesh-core/domain/tokens";
import { createSystemClock } from "wire-mesh-core/adapters/system-clock";
import { deviceIdFromHex } from "wire-mesh-core/domain/device-id";
import { MeshStore } from "../core/mesh-store.js";
import type { DeliveryEvent } from "../core/types.js";
import { loadOrCreateIdentity, saveRoomToken } from "../core/identity-store.js";
import type { IdentitySlot } from "../core/identity-store.js";
import { toIdentityPort } from "../core/wire-mesh-identity.js";
import { waitFor, wireTestTransport } from "./test-transport.js";

let nextPort = 20_970;
function freshPort(): number {
  nextPort += 1;
  return nextPort;
}

async function makeConnectedPair(port: number): Promise<{
  owner: MeshStore;
  ownerSlot: IdentitySlot;
  member: MeshStore;
  memberSlot: IdentitySlot;
}> {
  const owner = new MeshStore(port);
  const ownerSlot = await wireTestTransport(owner);
  await owner.init();
  await owner.registerAgent({
    name: "owner",
    harness: "test",
    cwd: "/test/owner",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });

  const member = new MeshStore(port);
  const memberSlot = await wireTestTransport(member);
  await member.init();
  await member.registerAgent({
    name: "member",
    harness: "test",
    cwd: "/test/member",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });

  await waitFor(
    () => owner.serialise().agents[member.peerId] !== undefined,
    "owner sees the member agent",
  );
  return { owner, ownerSlot, member, memberSlot };
}

/** Mints a member grant directly, under the owner's own persisted identity, and persists it into the member's own slot -- bypassing the wire-level room.join round trip entirely, per this file's own header comment on why that round trip can't be exercised in a live two-peer test here. */
async function grantMembership(
  ownerSlot: IdentitySlot,
  memberSlot: IdentitySlot,
  roomPath: string,
  memberDeviceHex: string,
): Promise<void> {
  const ownerIdentity = await toIdentityPort(loadOrCreateIdentity(ownerSlot));
  const clock = createSystemClock();
  const verdict = await mintCapabilityToken({
    identity: ownerIdentity,
    clock,
    tokenId: new Uint8Array([1]),
    bearer: deviceIdFromHex(memberDeviceHex),
    capability: "room:member",
    scope: { kind: "room", path: roomPath },
    expires: clock.now() + 60_000,
    delegationsRemaining: 0,
  });
  assert.ok(verdict.ok, "expected the fixture grant to mint successfully");
  if (!verdict.ok) return;
  saveRoomToken(memberSlot, roomPath, verdict.token);
}

void test("a directed room.send delivers to the recipient's own onDelivery", async () => {
  const { owner, ownerSlot, member, memberSlot } =
    await makeConnectedPair(freshPort());

  try {
    const room = await owner.createRoom({
      name: "general",
      type: "public",
      owner: owner.peerId,
      description: "",
    });
    await grantMembership(ownerSlot, memberSlot, room.id, member.peerId);

    const deliveries: DeliveryEvent[] = [];
    member.onDelivery = (_agentId, event) => {
      deliveries.push(event);
    };

    await owner.sendRoomMessageDirected(room.id, member.peerId, "hello there");

    await waitFor(
      () => deliveries.some((event) => event.type === "room_message"),
      "member receives the directed room.send",
    );
    const delivered = deliveries.find((event) => event.type === "room_message");
    assert.ok(delivered);
    if (delivered.type !== "room_message") return;
    assert.equal(delivered.message.content, "hello there");
    assert.equal(delivered.message.from, owner.peerId);
    assert.equal(delivered.message.room, room.id);
  } finally {
    await member.shutdown();
    await owner.shutdown();
  }
});

void test("a directed room.send from a member (not just the owner) also delivers", async () => {
  const { owner, ownerSlot, member, memberSlot } =
    await makeConnectedPair(freshPort());

  try {
    const room = await owner.createRoom({
      name: "general",
      type: "public",
      owner: owner.peerId,
      description: "",
    });
    await grantMembership(ownerSlot, memberSlot, room.id, member.peerId);

    const deliveries: DeliveryEvent[] = [];
    owner.onDelivery = (_agentId, event) => {
      deliveries.push(event);
    };

    await member.sendRoomMessageDirected(room.id, owner.peerId, "hi back");

    await waitFor(
      () => deliveries.some((event) => event.type === "room_message"),
      "owner receives the directed room.send",
    );
  } finally {
    await member.shutdown();
    await owner.shutdown();
  }
});

void test("sendRoomMessageDirected throws when this store holds no token for the room", async () => {
  const { owner, member } = await makeConnectedPair(freshPort());

  try {
    const room = await owner.createRoom({
      name: "general",
      type: "public",
      owner: owner.peerId,
      description: "",
    });
    // Deliberately not granted -- member has no persisted token for this room.
    await assert.rejects(
      member.sendRoomMessageDirected(room.id, owner.peerId, "uninvited"),
      /No room:member token/,
    );
  } finally {
    await member.shutdown();
    await owner.shutdown();
  }
});

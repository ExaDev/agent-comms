/**
 * Integration test for room.read's directed delivery (P3.5): a member reading a room message notifies only that message's own author via a real, wire-authenticated room.read request, updating the author's own local readBy and firing a delivery_status event locally on the author's side -- replacing the legacy message_read patch's mesh-wide broadcast.
 *
 * Membership is set up by minting and persisting the member's own token directly, matching room-send-directed.integration.test.ts's own reasoning: the legacy full-state-sync makes a real room.join round trip structurally unreachable in a two-peer test here, and it's irrelevant to what this file tests.
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

let nextPort = 20_990;
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

/** Mints a member grant directly under the owner's own persisted identity, for both directions: memberDeviceHex needs a persisted token in bearerSlot to authorise its own future sends (room.send or room.read) for roomPath. */
async function grantMembership(
  ownerSlot: IdentitySlot,
  bearerSlot: IdentitySlot,
  roomPath: string,
  bearerDeviceHex: string,
): Promise<void> {
  const ownerIdentity = await toIdentityPort(loadOrCreateIdentity(ownerSlot));
  const clock = createSystemClock();
  const verdict = await mintCapabilityToken({
    identity: ownerIdentity,
    clock,
    tokenId: new Uint8Array([1]),
    bearer: deviceIdFromHex(bearerDeviceHex),
    capability: "room:member",
    scope: { kind: "room", path: roomPath },
    expires: clock.now() + 60_000,
    delegationsRemaining: 0,
  });
  assert.ok(verdict.ok, "expected the fixture grant to mint successfully");
  if (!verdict.ok) return;
  saveRoomToken(bearerSlot, roomPath, verdict.token);
}

void test("reading a directed room.send notifies only its own author via room.read", async () => {
  const { owner, ownerSlot, member, memberSlot } =
    await makeConnectedPair(freshPort());

  try {
    const room = await owner.createRoom({
      name: "general",
      type: "public",
      owner: owner.peerId,
      description: "",
    });
    // member needs both a token (to authorise its own future room.read) and real CRDT membership (sendRoomMessage's own fan-out iterates room.members, a separate fact from token possession -- grantMembership only mints the token, mirroring admitRoomJoin's own two-part effect by hand).
    await grantMembership(ownerSlot, memberSlot, room.id, member.peerId);
    await owner.joinRoom(room.id, member.peerId);

    const ownerDeliveries: DeliveryEvent[] = [];
    owner.onDelivery = (_agentId, event) => {
      ownerDeliveries.push(event);
    };
    const memberDeliveries: DeliveryEvent[] = [];
    member.onDelivery = (_agentId, event) => {
      memberDeliveries.push(event);
    };

    await owner.sendRoomMessage(room.id, owner.peerId, "hello there");
    await waitFor(
      () => memberDeliveries.some((event) => event.type === "room_message"),
      "member receives the directed room.send",
    );

    // fireLocalDelivery's own auto-mark-read timer fires markRead for member, which should reach owner as a directed room.read -- no explicit action needed here.
    await waitFor(
      () =>
        ownerDeliveries.some(
          (event) =>
            event.type === "delivery_status" && event.status === "read",
        ),
      "owner receives the read receipt",
    );
    const readReceipt = ownerDeliveries.find(
      (event): event is Extract<DeliveryEvent, { type: "delivery_status" }> =>
        event.type === "delivery_status" && event.status === "read",
    );
    assert.ok(readReceipt);
    assert.equal(readReceipt.agent, member.peerId);
    assert.equal(readReceipt.room, room.id);

    const ownerHistory = await owner.readRoomMessages(room.id);
    const sent = ownerHistory.find((m) => m.content === "hello there");
    assert.ok(sent);
    assert.ok(sent.readBy.includes(member.peerId));
  } finally {
    await member.shutdown();
    await owner.shutdown();
  }
});

void test("reading a message from a peer with no room:member token for it does nothing beyond the local readBy update", async () => {
  const { owner, ownerSlot, member, memberSlot } =
    await makeConnectedPair(freshPort());

  try {
    const room = await owner.createRoom({
      name: "general",
      type: "public",
      owner: owner.peerId,
      description: "",
    });
    // member is deliberately never granted its own token here (owner's own token from createRoom is enough to send the message): member's auto-mark-read has nothing to authenticate a room.read with, so owner is never told about the read.
    const ownerDeliveries: DeliveryEvent[] = [];
    owner.onDelivery = (_agentId, event) => {
      ownerDeliveries.push(event);
    };
    const memberDeliveries: DeliveryEvent[] = [];
    member.onDelivery = (_agentId, event) => {
      memberDeliveries.push(event);
    };

    await owner.sendRoomMessageDirected(room.id, member.peerId, "hi");
    await waitFor(
      () => memberDeliveries.some((event) => event.type === "room_message"),
      "member receives the directed room.send",
    );

    // Give the auto-mark-read timer a real chance to fire and (incorrectly) notify owner before asserting it never did.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(
      ownerDeliveries.some((event) => event.type === "delivery_status"),
      false,
    );
  } finally {
    await member.shutdown();
    await owner.shutdown();
  }
});

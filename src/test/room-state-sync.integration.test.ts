/**
 * Integration test for room-state sync (P3.6): a joiner's own local Room record gets the room's real name/description/type from room.join's response, and a later room.members refresh picks up changes made after the join (here, simulated by mutating the owner's own room record directly, since no rename/re-describe verb exists yet).
 */

import * as assert from "node:assert/strict";
import { test } from "node:test";
import { MeshStore } from "../core/mesh-store.js";
import { waitFor, wireTestTransport } from "./test-transport.js";

let nextPort = 21_010;
function freshPort(): number {
  nextPort += 1;
  return nextPort;
}

async function makeConnectedPair(port: number): Promise<{
  owner: MeshStore;
  member: MeshStore;
}> {
  const owner = new MeshStore(port);
  await wireTestTransport(owner);
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
  await wireTestTransport(member);
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
  return { owner, member };
}

/** Drives a real, admitted room.join round trip: sends the request, waits for the owner to see it pending, accepts it, and waits for the join to resolve. */
async function joinAndAccept(
  owner: MeshStore,
  member: MeshStore,
  roomId: string,
): Promise<void> {
  const joinPromise = member.joinRoom(roomId, member.peerId);
  await waitFor(
    () =>
      owner
        .listPendingRoomJoins()
        .some((p) => p.roomPath === roomId && p.requesterId === member.peerId),
    "owner to see member's pending join request",
  );
  owner.acceptRoomJoin(roomId, member.peerId);
  await joinPromise;
}

void test("a joiner's own local room record carries the room's real name, description, and type", async () => {
  const { owner, member } = await makeConnectedPair(freshPort());

  try {
    const room = await owner.createRoom({
      name: "General Chat",
      type: "private",
      owner: owner.peerId,
      description: "the main room",
    });

    await joinAndAccept(owner, member, room.id);

    const memberCopy = await member.getRoom(room.id);
    assert.ok(memberCopy);
    // createRoom slugs the raw name before storing it (General-Chat, not General Chat) -- the point of this assertion is that member's own copy matches owner's own stored value exactly, not the pre-slug input.
    assert.equal(memberCopy.name, "General-Chat");
    assert.equal(memberCopy.description, "the main room");
    assert.equal(memberCopy.type, "private");
  } finally {
    await member.shutdown();
    await owner.shutdown();
  }
});

void test("refreshRoomMembers re-syncs a member's own local room record from the owner", async () => {
  const { owner, member } = await makeConnectedPair(freshPort());

  try {
    const room = await owner.createRoom({
      name: "General Chat",
      type: "public",
      owner: owner.peerId,
      description: "the main room",
    });
    await joinAndAccept(owner, member, room.id);

    // A change on the owner's own side that room.join's own response never carries after the fact -- refreshRoomMembers is the only way member ever learns of it.
    const ownerCopy = await owner.getRoom(room.id);
    assert.ok(ownerCopy);
    ownerCopy.description = "renamed after the join";

    const refreshed = await member.refreshRoomMembers(room.id);
    assert.equal(refreshed.description, "renamed after the join");
    assert.ok(refreshed.members.includes(owner.peerId));
    assert.ok(refreshed.members.includes(member.peerId));

    const memberCopy = await member.getRoom(room.id);
    assert.equal(memberCopy?.description, "renamed after the join");
  } finally {
    await member.shutdown();
    await owner.shutdown();
  }
});

void test("refreshRoomMembers throws for a DM path -- no Room record exists to refresh", async () => {
  const { owner, member } = await makeConnectedPair(freshPort());

  try {
    await assert.rejects(
      member.refreshRoomMembers(`${owner.peerId}+${member.peerId}`),
      /not found/i,
    );
  } finally {
    await member.shutdown();
    await owner.shutdown();
  }
});

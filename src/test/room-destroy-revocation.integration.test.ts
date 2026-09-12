/**
 * Integration test for destroy-via-revocation (P3.8): destroying a room revokes every member's own room:member grant for real, the same way kicking one member already does, so a fellow member's own independent token verification rejects a former member's message even after the room itself is gone from the owner's own bookkeeping.
 */

import * as assert from "node:assert/strict";
import { test } from "node:test";
import { MeshStore } from "../core/mesh-store.js";
import { waitFor, wireTestTransport } from "./test-transport.js";

let nextPort = 21_410;
function freshPort(): number {
  nextPort += 1;
  return nextPort;
}

async function makeRegisteredStore(
  port: number,
  name: string,
): Promise<MeshStore> {
  const store = new MeshStore(port);
  await wireTestTransport(store);
  await store.init();
  await store.registerAgent({
    name,
    harness: "test",
    cwd: `/test/${name}`,
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  return store;
}

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

void test("destroying a room revokes every member's own grant for every peer, not just the owner", async () => {
  const port = freshPort();
  const owner = await makeRegisteredStore(port, "owner");
  const memberA = await makeRegisteredStore(port, "member-a");
  const memberB = await makeRegisteredStore(port, "member-b");

  try {
    await waitFor(
      () =>
        owner.serialise().agents[memberA.peerId] !== undefined &&
        owner.serialise().agents[memberB.peerId] !== undefined &&
        memberA.serialise().agents[memberB.peerId] !== undefined &&
        memberB.serialise().agents[memberA.peerId] !== undefined,
      "owner and both members see one another",
    );

    const room = await owner.createRoom({
      name: "general",
      type: "public",
      owner: owner.peerId,
      description: "",
    });
    await joinAndAccept(owner, memberB, room.id);
    await joinAndAccept(owner, memberA, room.id);

    await owner.destroyRoom(room.id, owner.peerId);
    // Settles the revocation-announce destroyRoom just broadcast for every member: B's own drain loop processes it asynchronously off the wire, with no observable side effect from outside B's own store to wait on affirmatively.
    await new Promise((resolve) => setTimeout(resolve, 300));

    await assert.rejects(
      memberA.sendRoomMessageDirected(room.id, memberB.peerId, "still here?"),
      /unauthorized/,
      "B must reject a room.send sent under a grant the owner already revoked by destroying the room",
    );
  } finally {
    await memberB.shutdown();
    await memberA.shutdown();
    await owner.shutdown();
  }
});

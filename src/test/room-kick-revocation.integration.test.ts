/**
 * Integration test for kick-via-revocation (P3.7): kicking a member mints and announces a real revocation-entry for the token-id the owner recorded when it admitted them, so every connected peer that independently verifies that member's own room:member token -- not just the room's owner -- starts rejecting it, once the revocation-announce actually reaches them.
 *
 * Three real peers: owner (mints and later revokes A's grant), A (the member being kicked), and B (a fellow member who never talks to A about the kick directly -- B's own rejection of A's post-kick message is what proves the revocation-announce genuinely propagated over the wire, not merely that owner's own local view updated).
 */

import * as assert from "node:assert/strict";
import { test } from "node:test";
import { MeshStore } from "../core/mesh-store.js";
import type { DeliveryEvent } from "../core/types.js";
import { waitFor, wireTestTransport } from "./test-transport.js";

let nextPort = 21_110;
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

void test("kicking a member revokes their room:member token for every peer, not just the owner", async () => {
  const port = freshPort();
  const owner = await makeRegisteredStore(port, "owner");
  const memberA = await makeRegisteredStore(port, "member-a");
  const memberB = await makeRegisteredStore(port, "member-b");

  try {
    // A's own fan-out to B below needs a real, direct A<->B peer connection, not merely each one's visibility of the coordinator (owner) -- so every pairwise agent-registry view must be settled, not just owner's own.
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
    // B joins first: admitRoomJoin's own room.join response reports the room's CURRENT member list at admission time, so A's own local room record (constructed from A's later join response) only ever reflects B's membership if B is already admitted by the time A joins -- A's fan-out loop below reads its own stale-at-join-time member list, not a live view of the owner's.
    await joinAndAccept(owner, memberB, room.id);
    await joinAndAccept(owner, memberA, room.id);

    const bDeliveries: DeliveryEvent[] = [];
    memberB.onDelivery = (_agentId, event) => {
      bDeliveries.push(event);
    };

    await memberA.sendRoomMessage(room.id, memberA.peerId, "before the kick");
    await waitFor(
      () =>
        bDeliveries.some(
          (event) =>
            event.type === "room_message" &&
            event.message.content === "before the kick",
        ),
      "B receives A's message while A is still a member",
    );

    await owner.kickFromRoom(room.id, memberA.peerId, owner.peerId);
    // Settles the revocation-announce this kick just broadcast: B's own drain loop processes it asynchronously off the wire, with no observable side effect from outside B's own store to wait on affirmatively.
    await new Promise((resolve) => setTimeout(resolve, 300));

    // sendRoomMessage (not used here) re-checks this store's own local CRDT room.members list, which the kick's own legacy room_upsert patch has by now also reached A through -- that would mask exactly what this test needs to isolate. sendRoomMessageDirected instead only ever consults A's own persisted bearer token (never revoked by kickFromRoom, which revokes the OWNER's own record of having issued it, not A's own copy), so it genuinely simulates a still-token-holding A trying to reach B directly -- the real scenario a token-side revocation exists to stop, independent of whatever A's own CRDT view happens to already know. B's own handleRoomSend rejects it with "unauthorized" (the announced revocation now verifies as revoked on B's own independent check), which sendRoomMessageDirected surfaces as a thrown error rather than swallowing it the way the fan-out path does.
    await assert.rejects(
      memberA.sendRoomMessageDirected(
        room.id,
        memberB.peerId,
        "after the kick",
      ),
      /unauthorized/,
      "B must reject a room.send sent under a token its owner already revoked",
    );

    assert.equal(
      bDeliveries.some(
        (event) =>
          event.type === "room_message" &&
          event.message.content === "after the kick",
      ),
      false,
      "B must not have delivered a message sent under a revoked token",
    );
  } finally {
    await memberB.shutdown();
    await memberA.shutdown();
    await owner.shutdown();
  }
});

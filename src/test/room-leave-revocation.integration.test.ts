/**
 * Integration tests for room.leave's real wire-level path (P3.8): a member leaving, or a target declining an invite it never joined, both tell the room's own owner over a real, wire-authenticated room.leave -- the owner revokes the sender's own grant for real (the same revocation machinery kickFromRoom already uses) and notifies accordingly (member_left for a real leave, invite_declined for a decline), rather than each mutating a local Room record nobody else reads.
 */

import * as assert from "node:assert/strict";
import { test } from "node:test";
import { MeshStore } from "../core/mesh-store.js";
import type { DeliveryEvent } from "../core/types.js";
import { loadRoomTokens } from "../core/identity-store.js";
import { waitFor, wireTestTransport } from "./test-transport.js";

let nextPort = 21_310;
function freshPort(): number {
  nextPort += 1;
  return nextPort;
}

async function makeRegisteredStore(
  port: number,
  name: string,
): Promise<{ store: MeshStore; slot: Awaited<ReturnType<typeof wireTestTransport>> }> {
  const store = new MeshStore(port);
  const slot = await wireTestTransport(store);
  await store.init();
  await store.registerAgent({
    name,
    harness: "test",
    cwd: `/test/${name}`,
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  return { store, slot };
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

void test("a member leaving revokes its own grant and notifies the other members", async () => {
  const port = freshPort();
  const { store: owner } = await makeRegisteredStore(port, "owner");
  const { store: memberA, slot: aSlot } = await makeRegisteredStore(
    port,
    "member-a",
  );
  const { store: memberB } = await makeRegisteredStore(port, "member-b");

  try {
    await waitFor(
      () =>
        owner.serialise().agents[memberA.peerId] !== undefined &&
        owner.serialise().agents[memberB.peerId] !== undefined,
      "owner sees both members",
    );

    const room = await owner.createRoom({
      name: "general",
      type: "public",
      owner: owner.peerId,
      description: "",
    });
    await joinAndAccept(owner, memberB, room.id);
    await joinAndAccept(owner, memberA, room.id);

    const ownerDeliveries: DeliveryEvent[] = [];
    owner.onDelivery = (_agentId, event) => {
      ownerDeliveries.push(event);
    };

    await memberA.leaveRoom(room.id, memberA.peerId);

    await waitFor(
      () =>
        ownerDeliveries.some(
          (event) => event.type === "member_left" && event.agent === memberA.peerId,
        ),
      "owner is notified that A left",
    );

    // A's own local token is gone, and A can no longer act as a member.
    assert.equal(loadRoomTokens(aSlot)[room.id], undefined);
    await assert.rejects(
      memberA.sendRoomMessageDirected(room.id, owner.peerId, "still here?"),
      { code: "NOT_A_MEMBER" },
    );
  } finally {
    await memberB.shutdown();
    await memberA.shutdown();
    await owner.shutdown();
  }
});

void test("declining an invite before ever joining revokes the pushed grant and notifies the owner", async () => {
  const port = freshPort();
  const { store: owner } = await makeRegisteredStore(port, "owner");
  const { store: target, slot: targetSlot } = await makeRegisteredStore(
    port,
    "target",
  );

  try {
    await waitFor(
      () => owner.serialise().agents[target.peerId] !== undefined,
      "owner sees the target",
    );

    const room = await owner.createRoom({
      name: "general",
      type: "private",
      owner: owner.peerId,
      description: "",
    });

    const ownerDeliveries: DeliveryEvent[] = [];
    owner.onDelivery = (_agentId, event) => {
      ownerDeliveries.push(event);
    };

    await owner.inviteToRoom(room.id, target.peerId, owner.peerId);
    await waitFor(
      () => loadRoomTokens(targetSlot)[room.id] !== undefined,
      "target holds the pushed grant",
    );

    await target.declineInvite(room.id, target.peerId, "not right now");

    await waitFor(
      () =>
        ownerDeliveries.some(
          (event) =>
            event.type === "invite_declined" && event.agent === target.peerId,
        ),
      "owner is notified of the decline",
    );
    const declined = ownerDeliveries.find(
      (event): event is Extract<DeliveryEvent, { type: "invite_declined" }> =>
        event.type === "invite_declined",
    );
    assert.ok(declined);
    assert.equal(declined.reason, "not right now");
    assert.equal(loadRoomTokens(targetSlot)[room.id], undefined);
  } finally {
    await target.shutdown();
    await owner.shutdown();
  }
});

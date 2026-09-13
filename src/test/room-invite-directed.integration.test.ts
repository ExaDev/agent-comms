/**
 * Integration test for room.invite's real wire-level path (P3.8): the room owner pushes an already-minted room:member grant to a target directly, over a real, wire-authenticated room.invite -- replacing the legacy broadcastPatch/deliverLocallyAndBroadcast fan-out (which reached every mesh-connected peer with a "delivery" patch, not just the intended target) with a directed request the target itself verifies before persisting the token.
 */

import { test, expect } from "vitest";
import { MeshStore } from "../core/mesh-store.js";
import type { DeliveryEvent } from "../core/types.js";
import { loadRoomTokens } from "../core/identity-store.js";
import { waitFor, wireTestTransport } from "./test-transport.js";

let nextPort = 21_210;
function freshPort(): number {
  nextPort += 1;
  return nextPort;
}

async function makeConnectedPair(port: number): Promise<{
  owner: MeshStore;
  target: MeshStore;
  targetSlot: Awaited<ReturnType<typeof wireTestTransport>>;
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

  const target = new MeshStore(port);
  const targetSlot = await wireTestTransport(target);
  await target.init();
  await target.registerAgent({
    name: "target",
    harness: "test",
    cwd: "/test/target",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });

  await waitFor(
    () => owner.serialise().agents[target.peerId] !== undefined,
    "owner sees the target agent",
  );
  return { owner, target, targetSlot };
}

test("inviting a target delivers a real room_invite carrying the room's own name/description and the inviter's own name/cwd", async () => {
  const { owner, target, targetSlot } = await makeConnectedPair(freshPort());

  try {
    const room = await owner.createRoom({
      name: "General Chat",
      type: "private",
      owner: owner.peerId,
      description: "the main room",
    });

    const targetDeliveries: DeliveryEvent[] = [];
    target.onDelivery = (_agentId, event) => {
      targetDeliveries.push(event);
    };

    await owner.inviteToRoom(room.id, target.peerId, owner.peerId);

    await waitFor(
      () => targetDeliveries.some((event) => event.type === "room_invite"),
      "target receives the invite",
    );
    const invite = targetDeliveries.find(
      (event): event is Extract<DeliveryEvent, { type: "room_invite" }> =>
        event.type === "room_invite",
    );
    expect(invite).toBeTruthy();
    if (invite === undefined)
      throw new Error("expected a room_invite delivery event");
    expect(invite.room).toBe(room.id);
    expect(invite.roomDescription).toBe("the main room");
    expect(invite.from).toBe(owner.peerId);
    expect(invite.fromName).toBe("owner");
    expect(invite.fromCwd).toBe("/test/owner");

    // The pushed grant is usable, not just delivered: the target holds a real, persisted room:member token for the room now.
    expect(loadRoomTokens(targetSlot)[room.id]).toBeTruthy();
  } finally {
    await target.shutdown();
    await owner.shutdown();
  }
});

test("inviting an unreachable target throws rather than silently dropping the invite", async () => {
  const owner = new MeshStore(freshPort());
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

  try {
    const room = await owner.createRoom({
      name: "General Chat",
      type: "private",
      owner: owner.peerId,
      description: "",
    });
    const strangerId = "b".repeat(64);
    await expect(
      owner.inviteToRoom(room.id, strangerId, owner.peerId),
    ).rejects.toMatchObject({ code: "INVITE_FAILED" });
  } finally {
    await owner.shutdown();
  }
});

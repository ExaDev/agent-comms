/**
 * Unit tests for downtime delivery replay (#28): events that accumulated in peers' delivery queues while a target's process was down fire onDelivery when the target applies its first snapshot, without transport involvement.
 */

import * as assert from "node:assert/strict";
import { test } from "node:test";
import { MeshStore } from "../core/mesh-store.js";
import type { SerialisedState } from "../core/wire-protocol.js";
import type { DeliveryEvent } from "../core/types.js";

/** A wire-accurate snapshot: production always applies parsed (cloned) state. */
function snapshotOf(store: MeshStore): SerialisedState {
  return structuredClone(store.serialise());
}

/** A local-only store: no transport start, so no ports and no flake. */
function makeStore(): MeshStore {
  return new MeshStore();
}

void test("events queued while the target was down replay on its first snapshot", async () => {
  const sender = makeStore();
  const author = await sender.registerAgent({
    name: "author",
    harness: "pi",
    cwd: "/tmp/p",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  // The target exists on the mesh (known to the sender) but its process is "down": modelled by only ever syncing snapshots into a future store.
  const target = makeStore();
  const targetAgent = await target.registerAgent({
    name: "target",
    harness: "claude-code",
    cwd: "/tmp/t",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  // Make the sender aware of the target, then take the target's store away.
  sender.applyStateSync(target.serialise());
  await sender.createRoom({
    name: "room",
    type: "public",
    owner: author.id,
    description: "x",
  });
  await sender.joinRoom("room", targetAgent.id);

  // While the target is down, a room message is sent to it.
  await sender.sendRoomMessage("room", author.id, "while you were away");
  const pending = snapshotOf(sender).deliveryQueues[targetAgent.id];
  assert.ok(pending !== undefined && pending.length > 0);

  // The target returns (fresh process, same agent id) and receives the sender's snapshot: the pending event must fire onDelivery.
  const returned = makeStore();
  const deliveries: DeliveryEvent[] = [];
  returned.onDelivery = (_id, ev) => {
    deliveries.push(ev);
  };
  returned.peerId = targetAgent.id;
  returned.applyStateSync(snapshotOf(sender));
  assert.equal(
    deliveries.some(
      (ev) =>
        ev.type === "room_message" &&
        ev.message.content === "while you were away",
    ),
    true,
  );

  // Transient notifications carry no consumption evidence, so they merge into the queue (drain bridges still see them) but never replay-fire.
  assert.equal(deliveries.filter((ev) => ev.type === "room_members").length, 0);
  const queue = snapshotOf(returned).deliveryQueues[targetAgent.id] ?? [];
  assert.equal(
    queue.some((ev) => ev.type === "room_members"),
    true,
  );

  // A second snapshot of the same state does not duplicate the push.
  returned.applyStateSync(snapshotOf(sender));
  assert.equal(
    deliveries.filter(
      (ev) =>
        ev.type === "room_message" &&
        ev.message.content === "while you were away",
    ).length,
    1,
  );
});

void test("a queue is bounded oldest-first so downtime cannot grow it without limit", async () => {
  const sender = makeStore();
  const author = await sender.registerAgent({
    name: "author",
    harness: "pi",
    cwd: "/tmp/p",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  const target = makeStore();
  const targetAgent = await target.registerAgent({
    name: "target",
    harness: "claude-code",
    cwd: "/tmp/t",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  sender.applyStateSync(target.serialise());
  await sender.createRoom({
    name: "room",
    type: "public",
    owner: author.id,
    description: "x",
  });
  await sender.joinRoom("room", targetAgent.id);

  for (let i = 0; i < 120; i++) {
    await sender.sendRoomMessage("room", author.id, `msg-${String(i)}`);
  }
  const queued = snapshotOf(sender).deliveryQueues[targetAgent.id] ?? [];
  assert.equal(queued.length, 100);
  assert.equal(
    queued[0]?.type === "room_message" &&
      queued[0].message.content === "msg-20",
    true,
  );
});

void test("a pending invite replays until accepted or declined", async () => {
  const sender = makeStore();
  const author = await sender.registerAgent({
    name: "owner",
    harness: "pi",
    cwd: "/tmp/p",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  const target = makeStore();
  const targetAgent = await target.registerAgent({
    name: "invitee",
    harness: "claude-code",
    cwd: "/tmp/t",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  sender.applyStateSync(target.serialise());
  await sender.createRoom({
    name: "private-room",
    type: "private",
    owner: author.id,
    description: "x",
  });
  await sender.inviteToRoom("private-room", targetAgent.id, author.id);

  const returned = makeStore();
  const deliveries: DeliveryEvent[] = [];
  returned.onDelivery = (_id, ev) => {
    deliveries.push(ev);
  };
  returned.peerId = targetAgent.id;

  // Still on the invited list: the invite replays.
  returned.applyStateSync(snapshotOf(sender));
  assert.equal(deliveries.filter((ev) => ev.type === "room_invite").length, 1);

  // Declined (no longer invited): the same snapshot no longer replays it.
  await sender.declineInvite("private-room", targetAgent.id, "not now");
  const declined = makeStore();
  const deliveries2: DeliveryEvent[] = [];
  declined.onDelivery = (_id, ev) => {
    deliveries2.push(ev);
  };
  declined.peerId = targetAgent.id;
  declined.applyStateSync(snapshotOf(sender));
  assert.equal(deliveries2.filter((ev) => ev.type === "room_invite").length, 0);
});

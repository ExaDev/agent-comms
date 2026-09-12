/**
 * Unit test for invite replay (#28): a pending room invite that accumulated in a peer's delivery queue while its target's process was down fires onDelivery when the target applies its first snapshot, without transport involvement, and stops replaying once the invite is consumed (accepted or declined). Split out of downtime-replay.test.ts, whose own other two tests covered room_message replay via applyStateSync/deliveryQueues -- machinery P3.5's directed room.send fan-out no longer uses for message delivery (see room-send-retry.integration.test.ts for that behaviour's own replacement). Invite delivery itself is untouched by that migration: room.invite's own receiving side is still P3.6 work, so this legacy replay path remains the real mechanism for it today.
 */

import * as assert from "node:assert/strict";
import { test } from "node:test";
import { MeshStore } from "../core/mesh-store.js";
import type { SerialisedState } from "../core/wire-protocol.js";
import type { DeliveryEvent } from "../core/types.js";
import { ownerNamedRoomPath } from "../core/room-path.js";
import { wireTestTransport } from "./test-transport.js";

/** A wire-accurate snapshot: production always applies parsed (cloned) state. */
function snapshotOf(store: MeshStore): SerialisedState {
  return structuredClone(store.serialise());
}

/** A local-only store: transport is set (registerAgent's own broadcastPatch needs one) but never started, so no ports and no flake -- the stores in these tests never actually connect. */
async function makeStore(): Promise<MeshStore> {
  const store = new MeshStore();
  await wireTestTransport(store);
  return store;
}

void test("a pending invite replays until accepted or declined", async () => {
  const sender = await makeStore();
  const author = await sender.registerAgent({
    name: "owner",
    harness: "pi",
    cwd: "/tmp/p",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  const target = await makeStore();
  const targetAgent = await target.registerAgent({
    name: "invitee",
    harness: "claude-code",
    cwd: "/tmp/t",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  sender.applyStateSync(target.serialise());
  const roomId = ownerNamedRoomPath(author.id, "private-room");
  await sender.createRoom({
    name: "private-room",
    type: "private",
    owner: author.id,
    description: "x",
  });
  await sender.inviteToRoom(roomId, targetAgent.id, author.id);

  const returned = await makeStore();
  const deliveries: DeliveryEvent[] = [];
  returned.onDelivery = (_id, ev) => {
    deliveries.push(ev);
  };
  returned.peerId = targetAgent.id;

  // Still on the invited list: the invite replays.
  returned.applyStateSync(snapshotOf(sender));
  assert.equal(deliveries.filter((ev) => ev.type === "room_invite").length, 1);

  // Declined (no longer invited): the same snapshot no longer replays it.
  await sender.declineInvite(roomId, targetAgent.id, "not now");
  const declined = await makeStore();
  const deliveries2: DeliveryEvent[] = [];
  declined.onDelivery = (_id, ev) => {
    deliveries2.push(ev);
  };
  declined.peerId = targetAgent.id;
  declined.applyStateSync(snapshotOf(sender));
  assert.equal(deliveries2.filter((ev) => ev.type === "room_invite").length, 0);
});

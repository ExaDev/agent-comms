/**
 * End-to-end test for MeshStore TCP peer mesh.
 *
 * Spawns two MeshStore instances, verifies coordinator discovery,
 * room creation, messaging, and delivery push.
 */

import { randomInt } from "node:crypto";
import { test, expect } from "vitest";
import { MeshStore } from "../core/mesh-store.js";
import { CommsTool } from "../core/tool.js";
import { buildAction } from "../core/bridge.js";
import type { DeliveryEvent } from "../core/types.js";
import { waitFor, wireTestTransport } from "./test-transport.js";

/** Start of this file's own reserved port band -- kept clear of the fixed literals every sibling integration test file hardcodes (19878-19897) so a random pick here can never collide with one of those. */
const E2E_PORT_RANGE_START = 20_100;
/** Width of the reserved band -- wide enough that two concurrent runs of this exact file on the same machine picking the same port by chance is negligible. */
const E2E_PORT_RANGE_WIDTH = 900;
/** Randomised per process rather than a fixed literal: a hardcoded port here deterministically collides (EADDRINUSE) with any other concurrent vitest run of this same file on the same machine -- confirmed repeatedly under real concurrent load, not hypothetical. */
const E2E_PORT = E2E_PORT_RANGE_START + randomInt(E2E_PORT_RANGE_WIDTH);

// ---------------------------------------------------------------------------
// Timing constants — settle windows for asynchronous mesh propagation. There is no "operation complete" signal for these steps, so the test waits a fixed budget rather than polling.
// ---------------------------------------------------------------------------

/** Milliseconds to give the coordinator time to bind its listening port. */
const COORDINATOR_BIND_SETTLE_MS = 100;
/** Milliseconds to give a newly joined peer time to connect and sync with the coordinator. */
const PEER_SYNC_SETTLE_MS = 300;
/** Milliseconds to wait for agent-list state to sync across the mesh. */
const STATE_SYNC_SETTLE_MS = 200;
/** Milliseconds to wait for a created room to propagate to other peers. */
const ROOM_CREATE_SETTLE_MS = 200;
/** Milliseconds to wait for an accepted room join to settle on both sides. */
const ROOM_JOIN_SETTLE_MS = 200;
/** Milliseconds to wait for a sent message (room message, DM, or tool-driven send) to be delivered. */
const MESSAGE_DELIVERY_SETTLE_MS = 300;

async function createStore(
  name: string,
  harness: string,
): Promise<{ store: MeshStore; tool: CommsTool; deliveries: DeliveryEvent[] }> {
  const store = new MeshStore({ coordinatorPort: E2E_PORT });
  await wireTestTransport(store);

  const deliveries: DeliveryEvent[] = [];
  store.onDelivery = (_agentId: string, event: DeliveryEvent) => {
    deliveries.push(event);
  };

  const tool = new CommsTool(store);

  await store.init();
  await store.registerAgent({
    name,
    harness,
    cwd: `/test/${name}`,
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });

  return { store, tool, deliveries };
}

async function main(): Promise<void> {
  console.log("Creating peer A (coordinator)...");
  const a = await createStore("peer-a", "test-a");

  // Give coordinator time to bind
  await sleep(COORDINATOR_BIND_SETTLE_MS);

  console.log("Creating peer B (joins mesh)...");
  const b = await createStore("peer-b", "test-b");

  // Give peer B time to connect and sync
  await sleep(PEER_SYNC_SETTLE_MS);

  // --- Test: list agents ---
  console.log("Test: list agents from A...");
  const agentsA = await a.store.listAgents(a.store.peerId);
  console.log(`  A sees ${String(agentsA.length)} agent(s)`);
  expect(agentsA.length >= 2, "A should see both agents").toBeTruthy();

  // Wait for state sync
  await sleep(STATE_SYNC_SETTLE_MS);

  console.log("Test: list agents from B...");
  const agentsB = await b.store.listAgents(b.store.peerId);
  console.log(`  B sees ${String(agentsB.length)} agent(s)`);
  expect(agentsB.length >= 2, "B should see both agents").toBeTruthy();

  // --- Test: create room ---
  console.log("Test: create room...");
  const roomId = `test-room-${String(Date.now())}`;
  const room = await a.store.createRoom({
    name: roomId,
    type: "public",
    owner: a.store.peerId,
    description: "Test room",
  });
  console.log(`  Created room: ${room.id}`);

  await sleep(ROOM_CREATE_SETTLE_MS);

  // --- Test: B sees the room ---
  console.log("Test: B lists rooms...");
  const roomsB = await b.store.listRooms(b.store.peerId);
  console.log(`  B sees ${String(roomsB.length)} room(s)`);
  expect(roomsB.length >= 1, "B should see the room").toBeTruthy();

  // --- Test: B joins room --- The room already replicated to B via legacy full-state-sync, but knowing about a room is not the same as holding a room:member token for it -- B's own join still goes through real wire-level admission, held open until A approves it.
  console.log("Test: B joins room...");
  const joinPromise = b.store.joinRoom(room.id, b.store.peerId);
  await waitFor(
    () =>
      a.store
        .listPendingRoomJoins()
        .some(
          (p) => p.roomPath === room.id && p.requesterId === b.store.peerId,
        ),
    "A to see B's pending join request",
  );
  a.store.acceptRoomJoin(room.id, b.store.peerId);
  await joinPromise;

  await sleep(ROOM_JOIN_SETTLE_MS);

  // --- Test: room membership visible on both sides ---
  console.log("Test: room membership on A and B...");
  const roomA = await a.store.getRoom(room.id);
  const roomB = await b.store.getRoom(room.id);
  console.log(`  A sees ${String(roomA?.members.length)} member(s)`);
  console.log(`  B sees ${String(roomB?.members.length)} member(s)`);
  expect(roomA?.members.length, "A should see 2 room members").toBe(2);
  expect(roomB?.members.length, "B should see 2 room members").toBe(2);

  // --- Test: A sends message, B receives delivery ---
  console.log("Test: A sends message to room...");
  b.deliveries.length = 0;
  await a.store.sendRoomMessage(room.id, a.store.peerId, "Hello from A!");

  await sleep(MESSAGE_DELIVERY_SETTLE_MS);

  console.log(`  B received ${String(b.deliveries.length)} delivery event(s)`);
  expect(
    b.deliveries.length >= 1,
    "B should receive the room message",
  ).toBeTruthy();
  const roomMsg = b.deliveries[0];
  expect(roomMsg).toBeTruthy();
  if (roomMsg === undefined) throw new Error("expected a delivery event");
  expect(roomMsg.type).toBe("room_message");
  if (roomMsg.type !== "room_message")
    throw new Error("expected a room_message event");
  expect(roomMsg.message.content).toBe("Hello from A!");

  // --- Test: DM from A to B --- The two-round DM consent flow (section 6): A's own outbound room.join is what authorises the DM, and B (the party contacted first) still needs a human decision.
  console.log("Test: A requests DM access from B...");
  const dmAccessPromise = a.store.requestDmAccess(b.store.peerId);
  await waitFor(
    () =>
      b.store
        .listPendingRoomJoins()
        .some((p) => p.requesterId === a.store.peerId),
    "B to see A's pending DM request",
  );
  const pendingDm = b.store
    .listPendingRoomJoins()
    .find((p) => p.requesterId === a.store.peerId);
  expect(pendingDm).toBeTruthy();
  if (pendingDm === undefined) throw new Error("expected a pending DM request");
  b.store.acceptRoomJoin(pendingDm.roomPath, a.store.peerId);
  await dmAccessPromise;

  console.log("Test: DM from A to B...");
  b.deliveries.length = 0;
  await a.store.sendDm(a.store.peerId, b.store.peerId, "Hey B!");

  await sleep(MESSAGE_DELIVERY_SETTLE_MS);

  console.log(`  B received ${String(b.deliveries.length)} DM event(s)`);
  expect(b.deliveries.length >= 1, "B should receive the DM").toBeTruthy();
  const dmEvent = b.deliveries[0];
  expect(dmEvent).toBeTruthy();
  if (dmEvent === undefined) throw new Error("expected a delivery event");
  expect(dmEvent.type).toBe("dm");

  // --- Test: read room messages ---
  console.log("Test: B reads room messages...");
  const messages = await b.store.readRoomMessages(room.id);
  console.log(`  B sees ${String(messages.length)} message(s)`);
  expect(messages.length >= 1, "B should see the message").toBeTruthy();

  // --- Test: CommsTool integration ---
  console.log("Test: CommsTool send via B...");
  b.deliveries.length = 0;
  const action = buildAction({
    action: "send",
    target: room.id,
    content: "Hello from B via tool!",
  });
  await b.tool.handle(
    {
      agentId: b.store.peerId,
      harness: "test-b",
      cwd: "/test/peer-b",
      pid: process.pid,
    },
    action,
  );

  await sleep(MESSAGE_DELIVERY_SETTLE_MS);

  console.log(`  A received ${String(a.deliveries.length)} delivery event(s)`);
  expect(a.deliveries.length >= 1, "A should receive B's message").toBeTruthy();

  // --- Cleanup ---
  console.log("Cleaning up...");
  await a.store.shutdown();
  await b.store.shutdown();

  console.log("\n✓ All tests passed!");
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

test("two MeshStore instances discover each other, create a shared room, message, and push-deliver over a real TCP peer mesh", async () => {
  await main();
});

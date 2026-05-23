/**
 * End-to-end test for MeshStore TCP peer mesh.
 *
 * Spawns two MeshStore instances, verifies coordinator discovery,
 * room creation, messaging, and delivery push.
 */

import { MeshStore } from "../core/mesh-store.js";
import { CommsTool } from "../core/tool.js";
import { buildAction } from "../core/bridge.js";
import type { DeliveryEvent } from "../core/types.js";
import * as assert from "node:assert/strict";

const E2E_PORT = 19878;

async function createStore(
  name: string,
  harness: string,
): Promise<{ store: MeshStore; tool: CommsTool; deliveries: DeliveryEvent[] }> {
  const store = new MeshStore(E2E_PORT);

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
  await sleep(100);

  console.log("Creating peer B (joins mesh)...");
  const b = await createStore("peer-b", "test-b");

  // Give peer B time to connect and sync
  await sleep(300);

  // --- Test: list agents ---
  console.log("Test: list agents from A...");
  const agentsA = await a.store.listAgents(a.store.peerId);
  console.log(`  A sees ${String(agentsA.length)} agent(s)`);
  assert.ok(agentsA.length >= 1, "A should see at least 1 agent");

  // Wait for state sync
  await sleep(200);

  console.log("Test: list agents from B...");
  const agentsB = await b.store.listAgents(b.store.peerId);
  console.log(`  B sees ${String(agentsB.length)} agent(s)`);
  assert.ok(agentsB.length >= 1, "B should see at least 1 agent");

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

  await sleep(200);

  // --- Test: B sees the room ---
  console.log("Test: B lists rooms...");
  const roomsB = await b.store.listRooms(b.store.peerId);
  console.log(`  B sees ${String(roomsB.length)} room(s)`);
  assert.ok(roomsB.length >= 1, "B should see the room");

  // --- Test: B joins room ---
  console.log("Test: B joins room...");
  await b.store.joinRoom(room.id, b.store.peerId);

  await sleep(200);

  // --- Test: A sends message, B receives delivery ---
  console.log("Test: A sends message to room...");
  b.deliveries.length = 0;
  await a.store.sendRoomMessage(room.id, a.store.peerId, "Hello from A!");

  await sleep(300);

  console.log(`  B received ${String(b.deliveries.length)} delivery event(s)`);
  assert.ok(b.deliveries.length >= 1, "B should receive the room message");
  const roomMsg = b.deliveries[0];
  assert.ok(roomMsg);
  assert.strictEqual(roomMsg.type, "room_message");
  assert.strictEqual(roomMsg.message.content, "Hello from A!");

  // --- Test: DM from A to B ---
  console.log("Test: DM from A to B...");
  b.deliveries.length = 0;
  await a.store.sendDm(a.store.peerId, b.store.peerId, "Hey B!");

  await sleep(300);

  console.log(`  B received ${String(b.deliveries.length)} DM event(s)`);
  assert.ok(b.deliveries.length >= 1, "B should receive the DM");
  const dmEvent = b.deliveries[0];
  assert.ok(dmEvent);
  assert.strictEqual(dmEvent.type, "dm");

  // --- Test: read room messages ---
  console.log("Test: B reads room messages...");
  const messages = await b.store.readRoomMessages(room.id);
  console.log(`  B sees ${String(messages.length)} message(s)`);
  assert.ok(messages.length >= 1, "B should see the message");

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

  await sleep(300);

  console.log(`  A received ${String(a.deliveries.length)} delivery event(s)`);
  assert.ok(a.deliveries.length >= 1, "A should receive B's message");

  // --- Cleanup ---
  console.log("Cleaning up...");
  await a.store.shutdown();
  await b.store.shutdown();

  console.log("\n✓ All tests passed!");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err: unknown) => {
  console.error("Test failed:", err);
  process.exit(1);
});

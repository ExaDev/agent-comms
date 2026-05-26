/**
 * Delivery receipt test helper — runs a single test case in isolation.
 *
 * Usage: node delivery-receipt.helper.js <test-name>
 *
 * Test names:
 *   push-room        — onDelivery fires for room messages
 *   push-dm          — onDelivery fires for DMs
 *   drain-room       — drainDelivery returns queued room messages
 *   drain-dm         — drainDelivery returns queued DMs
 *   read-receipt-push — read receipt after onDelivery
 *   read-receipt-drain — read receipt after drainDelivery
 *   readby-array     — message readBy array updated
 */

import { MeshStore } from "../core/mesh-store.js";
import assert from "node:assert/strict";

const testName = process.argv[2];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Unique port per process + test name to avoid TIME_WAIT collisions
 * across sequential runs. Uses a hash of the test name mixed with the
 * process PID to produce a port in the ephemeral range.
 */
function allocPort(): number {
  let hash = 0;
  const input = `${testName}-${process.pid}`;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  return 40000 + (Math.abs(hash) % 10000);
}

const PORT = allocPort();

async function cleanup(...stores: MeshStore[]): Promise<void> {
  for (const s of stores) {
    await s.shutdown();
  }
}

// ---------------------------------------------------------------------------
// Test implementations
// ---------------------------------------------------------------------------

async function testPushRoom(): Promise<void> {
  const a = new MeshStore(PORT);
  const deliveriesA: unknown[] = [];
  a.onDelivery = () => {
    deliveriesA.push(1);
  };
  await a.init();
  await a.registerAgent({
    name: "a",
    harness: "test",
    cwd: "/test/a",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  await sleep(100);

  const b = new MeshStore(PORT);
  const deliveriesB: Record<string, unknown>[] = [];
  b.onDelivery = (_id: string, ev: unknown) => {
    deliveriesB.push(ev as Record<string, unknown>);
  };
  await b.init();
  await b.registerAgent({
    name: "b",
    harness: "test",
    cwd: "/test/b",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  await sleep(300);

  const room = await a.createRoom({
    name: `push-room-${PORT}`,
    type: "public",
    owner: a.peerId,
    description: "Push delivery test",
  });
  await sleep(200);
  await b.joinRoom(room.id, b.peerId);
  await sleep(200);

  deliveriesB.length = 0;
  await a.sendRoomMessage(room.id, a.peerId, "Hello push!");
  await sleep(300);

  assert.ok(
    deliveriesB.length >= 1,
    `B should receive at least 1 delivery, got ${String(deliveriesB.length)}`,
  );
  const roomMsg = deliveriesB.find((ev) => ev.type === "room_message");
  assert.ok(roomMsg !== undefined, "Should find room_message event");
  const message = roomMsg.message as Record<string, unknown>;
  assert.strictEqual(message.content, "Hello push!");
  assert.strictEqual(message.from, a.peerId);

  await cleanup(a, b);
}

async function testPushDm(): Promise<void> {
  const a = new MeshStore(PORT);
  const deliveriesA: unknown[] = [];
  a.onDelivery = () => {
    deliveriesA.push(1);
  };
  await a.init();
  await a.registerAgent({
    name: "a",
    harness: "test",
    cwd: "/test/a",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  await sleep(100);

  const b = new MeshStore(PORT);
  const deliveriesB: Record<string, unknown>[] = [];
  b.onDelivery = (_id: string, ev: unknown) => {
    deliveriesB.push(ev as Record<string, unknown>);
  };
  await b.init();
  await b.registerAgent({
    name: "b",
    harness: "test",
    cwd: "/test/b",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  await sleep(300);

  deliveriesB.length = 0;
  await a.sendDm(a.peerId, b.peerId, "Direct push!");
  await sleep(300);

  assert.ok(
    deliveriesB.length >= 1,
    `B should receive DM, got ${String(deliveriesB.length)}`,
  );
  const dm = deliveriesB.find((ev) => ev.type === "dm");
  assert.ok(dm !== undefined, "Should find dm event");
  const message = dm.message as Record<string, unknown>;
  assert.strictEqual(message.content, "Direct push!");
  assert.strictEqual(message.from, a.peerId);

  await cleanup(a, b);
}

async function testDrainRoom(): Promise<void> {
  const a = new MeshStore(PORT);
  await a.init();
  await a.registerAgent({
    name: "a",
    harness: "test",
    cwd: "/test/a",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  await sleep(100);

  // B has NO onDelivery — events queue for drain
  const b = new MeshStore(PORT);
  await b.init();
  await b.registerAgent({
    name: "b",
    harness: "test",
    cwd: "/test/b",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  await sleep(300);

  const room = await a.createRoom({
    name: `drain-room-${PORT}`,
    type: "public",
    owner: a.peerId,
    description: "Drain delivery test",
  });
  await sleep(200);
  await b.joinRoom(room.id, b.peerId);
  await sleep(200);

  await a.sendRoomMessage(room.id, a.peerId, "Hello drain!");
  await sleep(300);

  const drained = await b.drainDelivery(b.peerId);
  assert.ok(
    drained.length >= 1,
    `drainDelivery should return events, got ${String(drained.length)}`,
  );
  const roomMsg = drained.find((e) => e.type === "room_message");
  assert.ok(
    roomMsg !== undefined,
    "Should find room_message in drained events",
  );
  assert.strictEqual(roomMsg.message.content, "Hello drain!");

  const drainedAgain = await b.drainDelivery(b.peerId);
  assert.strictEqual(
    drainedAgain.length,
    0,
    "Second drainDelivery should return no events",
  );

  await cleanup(a, b);
}

async function testDrainDm(): Promise<void> {
  const a = new MeshStore(PORT);
  await a.init();
  await a.registerAgent({
    name: "a",
    harness: "test",
    cwd: "/test/a",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  await sleep(100);

  const b = new MeshStore(PORT);
  await b.init();
  await b.registerAgent({
    name: "b",
    harness: "test",
    cwd: "/test/b",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  await sleep(300);

  await a.sendDm(a.peerId, b.peerId, "Direct drain!");
  await sleep(300);

  const drained = await b.drainDelivery(b.peerId);
  assert.ok(
    drained.length >= 1,
    `drainDelivery should return DM, got ${String(drained.length)}`,
  );
  assert.strictEqual(drained[0].type, "dm");
  assert.strictEqual(drained[0].message.content, "Direct drain!");

  await cleanup(a, b);
}

async function testReadReceiptPush(): Promise<void> {
  const a = new MeshStore(PORT);
  const deliveriesA: Record<string, unknown>[] = [];
  a.onDelivery = (_id: string, ev: unknown) => {
    deliveriesA.push(ev as Record<string, unknown>);
  };
  await a.init();
  await a.registerAgent({
    name: "a",
    harness: "test",
    cwd: "/test/a",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  await sleep(100);

  const b = new MeshStore(PORT);
  b.onDelivery = () => {};
  await b.init();
  await b.registerAgent({
    name: "b",
    harness: "test",
    cwd: "/test/b",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  await sleep(300);

  const room = await a.createRoom({
    name: `read-push-${PORT}`,
    type: "public",
    owner: a.peerId,
    description: "Read receipt push test",
  });
  await sleep(200);
  await b.joinRoom(room.id, b.peerId);
  await sleep(200);

  deliveriesA.length = 0;
  await a.sendRoomMessage(room.id, a.peerId, "Read me");
  await sleep(500);

  const readReceipt = deliveriesA.find(
    (ev) => ev.type === "delivery_status" && ev.status === "read",
  );
  assert.ok(readReceipt !== undefined, "A should receive a read receipt");
  assert.strictEqual(readReceipt.agent, b.peerId);

  await cleanup(a, b);
}

async function testReadReceiptDrain(): Promise<void> {
  const a = new MeshStore(PORT);
  const deliveriesA: Record<string, unknown>[] = [];
  a.onDelivery = (_id: string, ev: unknown) => {
    deliveriesA.push(ev as Record<string, unknown>);
  };
  await a.init();
  await a.registerAgent({
    name: "a",
    harness: "test",
    cwd: "/test/a",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  await sleep(100);

  // B has NO onDelivery — drain triggers markRead
  const b = new MeshStore(PORT);
  await b.init();
  await b.registerAgent({
    name: "b",
    harness: "test",
    cwd: "/test/b",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  await sleep(300);

  const room = await a.createRoom({
    name: `read-drain-${PORT}`,
    type: "public",
    owner: a.peerId,
    description: "Read receipt drain test",
  });
  await sleep(200);
  await b.joinRoom(room.id, b.peerId);
  await sleep(200);

  deliveriesA.length = 0;
  await a.sendRoomMessage(room.id, a.peerId, "Drain then read");
  await sleep(300);

  const drained = await b.drainDelivery(b.peerId);
  assert.ok(drained.length >= 1, "Drain should return the message");
  await sleep(300);

  const readReceipt = deliveriesA.find(
    (ev) => ev.type === "delivery_status" && ev.status === "read",
  );
  assert.ok(
    readReceipt !== undefined,
    "A should receive a read receipt after drain",
  );

  await cleanup(a, b);
}

async function testReadbyArray(): Promise<void> {
  const a = new MeshStore(PORT);
  a.onDelivery = () => {};
  await a.init();
  await a.registerAgent({
    name: "a",
    harness: "test",
    cwd: "/test/a",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  await sleep(100);

  const b = new MeshStore(PORT);
  b.onDelivery = () => {};
  await b.init();
  await b.registerAgent({
    name: "b",
    harness: "test",
    cwd: "/test/b",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  await sleep(300);

  const room = await a.createRoom({
    name: `readby-${PORT}`,
    type: "public",
    owner: a.peerId,
    description: "readBy test",
  });
  await sleep(200);
  await b.joinRoom(room.id, b.peerId);
  await sleep(200);

  const msg = await a.sendRoomMessage(room.id, a.peerId, "Check readBy");
  await sleep(800);

  const messages = await a.readRoomMessages(room.id);
  const sent = messages.find((m) => m.id === msg.id);
  assert.ok(sent !== undefined, "Should find the sent message");
  assert.ok(
    sent.readBy.includes(b.peerId),
    `readBy should include B, got: ${sent.readBy.join(", ")}`,
  );

  await cleanup(a, b);
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const tests: Record<string, () => Promise<void>> = {
  "push-room": testPushRoom,
  "push-dm": testPushDm,
  "drain-room": testDrainRoom,
  "drain-dm": testDrainDm,
  "read-receipt-push": testReadReceiptPush,
  "read-receipt-drain": testReadReceiptDrain,
  "readby-array": testReadbyArray,
};

const fn = tests[testName];
if (!fn) {
  console.error(`Unknown test: ${testName}`);
  console.error(`Available: ${Object.keys(tests).join(", ")}`);
  process.exit(1);
}

fn()
  .then(() => {
    // Force exit — pending markRead timers and socket close handlers
    // can keep the event loop alive even after shutdown().
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error(`FAIL [${testName}]:`, err);
    process.exit(1);
  });

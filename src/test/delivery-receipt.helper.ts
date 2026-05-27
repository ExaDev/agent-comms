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
import type { DeliveryEvent } from "../core/types.js";
import * as net from "node:net";
import assert from "node:assert/strict";

const testName = process.argv[2];
if (testName === undefined) {
  console.error("Usage: node delivery-receipt.helper.ts <test-name>");
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Allocate a genuinely free coordinator port. Creates a probe server on
 * port 0, records the OS-assigned port, then immediately closes the
 * probe. Uses SO_REUSEADDR on the probe so the port doesn't enter
 * TIME_WAIT — making it immediately available for the coordinator.
 */
async function allocFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    // SO_REUSEADDR avoids TIME_WAIT on close
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
    server.on("error", reject);
  });
}

async function cleanup(...stores: MeshStore[]): Promise<void> {
  for (const s of stores) {
    await s.shutdown();
  }
}

// ---------------------------------------------------------------------------
// Test implementations
// ---------------------------------------------------------------------------

async function testPushRoom(): Promise<void> {
  const port = await allocFreePort();
  const a = new MeshStore(port);
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

  const b = new MeshStore(port);
  const deliveriesB: DeliveryEvent[] = [];
  b.onDelivery = (_id: string, ev: DeliveryEvent) => {
    deliveriesB.push(ev);
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
    name: `push-room-${String(port)}`,
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
  const roomMsg = deliveriesB.find(
    (ev): ev is Extract<DeliveryEvent, { type: "room_message" }> =>
      ev.type === "room_message",
  );
  assert.ok(roomMsg !== undefined, "Should find room_message event");
  assert.strictEqual(roomMsg.message.content, "Hello push!");
  assert.strictEqual(roomMsg.message.from, a.peerId);

  await cleanup(a, b);
}

async function testPushDm(): Promise<void> {
  const port = await allocFreePort();
  const a = new MeshStore(port);
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

  const b = new MeshStore(port);
  const deliveriesB: DeliveryEvent[] = [];
  b.onDelivery = (_id: string, ev: DeliveryEvent) => {
    deliveriesB.push(ev);
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
  assert.strictEqual(dm.message.content, "Direct push!");
  assert.strictEqual(dm.message.from, a.peerId);

  await cleanup(a, b);
}

async function testDrainRoom(): Promise<void> {
  const port = await allocFreePort();
  const a = new MeshStore(port);
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
  const b = new MeshStore(port);
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
    name: `drain-room-${String(port)}`,
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
  const port = await allocFreePort();
  const a = new MeshStore(port);
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

  const b = new MeshStore(port);
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
  const event = drained[0];
  assert.ok(event, "drainDelivery should return at least one event");
  assert.strictEqual(event.type, "dm");
  assert.strictEqual(event.message.content, "Direct drain!");

  await cleanup(a, b);
}

async function testReadReceiptPush(): Promise<void> {
  const port = await allocFreePort();
  const a = new MeshStore(port);
  const deliveriesA: DeliveryEvent[] = [];
  a.onDelivery = (_id: string, ev: DeliveryEvent) => {
    deliveriesA.push(ev);
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

  const b = new MeshStore(port);
  b.onDelivery = () => {
    /* intentionally empty — dummy handler for drain delivery */
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
    name: `read-push-${String(port)}`,
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
    (ev): ev is Extract<DeliveryEvent, { type: "delivery_status" }> =>
      ev.type === "delivery_status" && ev.status === "read",
  );
  assert.ok(readReceipt !== undefined, "A should receive a read receipt");
  assert.strictEqual(readReceipt.agent, b.peerId);

  await cleanup(a, b);
}

async function testReadReceiptDrain(): Promise<void> {
  const port = await allocFreePort();
  const a = new MeshStore(port);
  const deliveriesA: DeliveryEvent[] = [];
  a.onDelivery = (_id: string, ev: DeliveryEvent) => {
    deliveriesA.push(ev);
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
  const b = new MeshStore(port);
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
    name: `read-drain-${String(port)}`,
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
  const port = await allocFreePort();
  const a = new MeshStore(port);
  a.onDelivery = () => {
    /* intentionally empty — dummy handler for drain delivery */
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

  const b = new MeshStore(port);
  b.onDelivery = () => {
    /* intentionally empty — dummy handler for drain delivery */
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
    name: `readby-${String(port)}`,
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
  .then(async () => {
    // Wait for all active handles to be cleaned up before exiting.
    // This ensures TCP sockets are properly closed (FIN sent, not RST)
    // and the OS releases the ports before the process exits, preventing
    // the parent process from hanging on subsequent fork/exec.
    const maxWait = 2000; // ms
    const start = Date.now();
    const getHandles: () => unknown[] =
      (process as unknown as { _getActiveHandles?: () => unknown[] })
        ._getActiveHandles ?? (() => []);
    const handles: unknown[] = getHandles();
    while (handles.length > 0 && Date.now() - start < maxWait) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error(`FAIL [${testName}]:`, err);
    process.exit(1);
  });

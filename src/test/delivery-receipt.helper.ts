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
import { wireTestTransport } from "./test-transport.js";

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

/** Polls until predicate holds or a fixed budget elapses -- these helpers wait on a real, cross-process wire round trip (admission, DM consent), not a fixed sleep. */
async function pollUntil(
  predicate: () => boolean | Promise<boolean>,
  what: string,
): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(50);
  }
}

/**
 * member's own real, admitted room.join: the room already replicated to member via legacy full-state-sync, but knowing about a room is not the same as holding a room:member token for it -- member's own join still goes through real wire-level admission, held open until owner approves it. Also waits for owner's own local membership record to actually reflect the join before returning: acceptRoomJoin only resolves the held-open request's promise, and its continuation (minting the token, updating the room) runs on a later tick, so a caller sending immediately afterward could otherwise read owner's room.members before that update lands.
 */
async function joinAndAccept(
  owner: MeshStore,
  member: MeshStore,
  roomId: string,
): Promise<void> {
  const joinPromise = member.joinRoom(roomId, member.peerId);
  await pollUntil(
    () =>
      owner
        .listPendingRoomJoins()
        .some((p) => p.roomPath === roomId && p.requesterId === member.peerId),
    "owner to see member's pending join request",
  );
  owner.acceptRoomJoin(roomId, member.peerId);
  await joinPromise;
  await pollUntil(async () => {
    const room = await owner.getRoom(roomId);
    return room?.members.includes(member.peerId) ?? false;
  }, "owner's own room record to reflect the join");
}

/** The two-round DM consent flow (section 6): from's own outbound room.join is what authorises the DM, and to (the party contacted first) still needs a human decision. */
async function dmConsent(from: MeshStore, to: MeshStore): Promise<void> {
  const accessPromise = from.requestDmAccess(to.peerId);
  await pollUntil(
    () => to.listPendingRoomJoins().some((p) => p.requesterId === from.peerId),
    "to see from's pending DM request",
  );
  const pending = to
    .listPendingRoomJoins()
    .find((p) => p.requesterId === from.peerId);
  if (pending === undefined) throw new Error("pending DM request vanished");
  to.acceptRoomJoin(pending.roomPath, from.peerId);
  await accessPromise;
}

// ---------------------------------------------------------------------------
// Test implementations
// ---------------------------------------------------------------------------

async function testPushRoom(): Promise<void> {
  const port = await allocFreePort();
  const a = new MeshStore(port);
  await wireTestTransport(a);
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
  await wireTestTransport(b);
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
  await joinAndAccept(a, b, room.id);

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
  await wireTestTransport(a);
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
  await wireTestTransport(b);
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

  await dmConsent(a, b);

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
  await wireTestTransport(a);
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
  await wireTestTransport(b);
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
  await joinAndAccept(a, b, room.id);

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
  await wireTestTransport(a);
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
  await wireTestTransport(b);
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

  await dmConsent(a, b);
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
  await wireTestTransport(a);
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
  await wireTestTransport(b);
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
  await joinAndAccept(a, b, room.id);

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
  await wireTestTransport(a);
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
  await wireTestTransport(b);
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
  await joinAndAccept(a, b, room.id);

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
  await wireTestTransport(a);
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
  await wireTestTransport(b);
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
  await joinAndAccept(a, b, room.id);

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

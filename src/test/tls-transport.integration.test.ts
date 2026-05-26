/**
 * TlsTransport integration test — verifies that two MeshStore instances
 * can communicate over TLS with certificate pinning.
 *
 * Run: node dist/test/tls-transport.integration.test.js
 */

import * as net from "node:net";
import * as assert from "node:assert/strict";
import { MeshStore } from "../core/mesh-store.js";
import { TlsTransport } from "../core/tls-transport.js";
import { generateIdentity } from "../core/identity.js";
import type { PeerIdentity } from "../core/identity.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function allocFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function cleanup(...stores: MeshStore[]): Promise<void> {
  for (const s of stores) {
    await s.shutdown();
  }
}

async function testTlsPeerCommunication(): Promise<void> {
  const port = await allocFreePort();
  const identityA: PeerIdentity = generateIdentity();
  const identityB: PeerIdentity = generateIdentity();

  // Verify identities are different
  assert.notStrictEqual(identityA.fingerprint, identityB.fingerprint);
  console.log("  Identity A:", identityA.fingerprint.substring(0, 23) + "...");
  console.log("  Identity B:", identityB.fingerprint.substring(0, 23) + "...");

  // Create stores with TLS transport
  const storeA = new MeshStore(port);
  storeA.peerId = identityA.fingerprint;
  storeA.setTransport(new TlsTransport(storeA.events, identityA));

  const deliveriesA: unknown[] = [];
  storeA.onDelivery = () => { deliveriesA.push(1); };
  await storeA.init();
  await storeA.registerAgent({
    name: "a",
    harness: "test",
    cwd: "/test/a",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  await sleep(100);

  const storeB = new MeshStore(port);
  storeB.peerId = identityB.fingerprint;
  storeB.setTransport(new TlsTransport(storeB.events, identityB));

  const deliveriesB: Record<string, unknown>[] = [];
  storeB.onDelivery = (_id: string, ev: unknown) => {
    deliveriesB.push(ev as Record<string, unknown>);
  };
  await storeB.init();
  await storeB.registerAgent({
    name: "b",
    harness: "test",
    cwd: "/test/b",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  await sleep(300);

  // Create room and exchange messages
  const room = await storeA.createRoom({
    name: `tls-test-${port}`,
    type: "public",
    owner: storeA.peerId,
    description: "TLS transport test",
  });
  await sleep(200);
  await storeB.joinRoom(room.id, storeB.peerId);
  await sleep(200);

  deliveriesB.length = 0;
  await storeA.sendRoomMessage(room.id, storeA.peerId, "Hello over TLS!");
  await sleep(300);

  assert.ok(deliveriesB.length >= 1, `B should receive at least 1 delivery, got ${String(deliveriesB.length)}`);
  const roomMsg = deliveriesB.find((ev) => ev.type === "room_message");
  assert.ok(roomMsg !== undefined, "Should find room_message event");
  const message = roomMsg.message as Record<string, unknown>;
  assert.strictEqual(message.content, "Hello over TLS!");
  assert.strictEqual(message.from, identityA.fingerprint);

  console.log("  ✓ Room message received over TLS");

  // Test DM
  deliveriesB.length = 0;
  await storeA.sendDm(storeA.peerId, storeB.peerId, "Direct over TLS!");
  await sleep(300);

  const dm = deliveriesB.find((ev) => ev.type === "dm");
  assert.ok(dm !== undefined, "Should find dm event");
  const dmMessage = dm.message as Record<string, unknown>;
  assert.strictEqual(dmMessage.content, "Direct over TLS!");
  assert.strictEqual(dmMessage.from, identityA.fingerprint);

  console.log("  ✓ DM received over TLS");

  await cleanup(storeA, storeB);
}

async function testFingerprintIsPeerId(): Promise<void> {
  const identity = generateIdentity();
  const port = await allocFreePort();

  const store = new MeshStore(port);
  store.peerId = identity.fingerprint;
  store.setTransport(new TlsTransport(store.events, identity));

  await store.init();
  const agent = await store.registerAgent({
    name: "fp-test",
    harness: "test",
    cwd: "/test/fp",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });

  // The agent ID should be the certificate fingerprint
  assert.strictEqual(agent.id, identity.fingerprint);
  console.log("  ✓ Peer ID equals certificate fingerprint");

  await store.shutdown();
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const testName = process.argv[2];

const tests: Record<string, () => Promise<void>> = {
  "tls-communication": testTlsPeerCommunication,
  "tls-fingerprint": testFingerprintIsPeerId,
};

const fn = tests[testName];
if (!fn) {
  console.error(`Unknown test: ${testName}`);
  console.error(`Available: ${Object.keys(tests).join(", ")}`);
  process.exit(1);
}

fn()
  .then(async () => {
    const maxWait = 2000;
    const start = Date.now();
    while (process._getActiveHandles().length > 0 && Date.now() - start < maxWait) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error(`FAIL [${testName}]:`, err);
    process.exit(1);
  });

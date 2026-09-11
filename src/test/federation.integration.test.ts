/**
 * Federation integration test — verifies that two MeshStore instances on different "machines" (simulated via separate TCP meshes) can federate through coordinator-to-coordinator TLS links, and that an inbound link presenting an untrusted certificate is rejected outright.
 *
 * Tests:
 * 0. An inbound connection with no pinned fingerprint is rejected
 * 1. Establish federation link between two meshes once both fingerprints are trusted
 * 2. Agent presence propagates across federation
 * 3. Messages in federated rooms propagate across federation
 * 4. Non-federated rooms are isolated (messages never cross)
 * 5. Federation link listing
 * 6. Disconnect federation link
 *
 * Run: node dist/test/federation.integration.test.js
 */

import { MeshStore } from "../core/mesh-store.js";
import type { DeliveryEvent, RoomMessage } from "../core/types.js";
import * as assert from "node:assert/strict";
import * as net from "node:net";
import { wireTestTransport } from "./test-transport.js";

// Use high ports to avoid collisions with real meshes
const MESH_A_PORT = 28876;
const MESH_B_PORT = 28877;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createMesh(
  name: string,
  coordinatorPort: number,
): Promise<{
  store: MeshStore;
  deliveries: DeliveryEvent[];
}> {
  const store = new MeshStore(coordinatorPort);
  wireTestTransport(store);
  const deliveries: DeliveryEvent[] = [];
  store.onDelivery = (_agentId: string, event: DeliveryEvent) => {
    deliveries.push(event);
  };

  await store.init();
  await store.registerAgent({
    name,
    harness: "test",
    cwd: `/test/${name}`,
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });

  return { store, deliveries };
}

/** Find a free port on localhost. */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr !== null) {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("Failed to get port")));
      }
    });
    server.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== Federation Integration Tests ===\n");

  console.log("Creating mesh A (coordinator)...");
  const a = await createMesh("mesh-a-agent", MESH_A_PORT);
  await sleep(100);

  console.log("Creating mesh B (coordinator)...");
  const b = await createMesh("mesh-b-agent", MESH_B_PORT);
  await sleep(100);

  const fedPort = await findFreePort();
  console.log(`Using federation port ${String(fedPort)}`);

  // Start A's real production federation listener (fedListen -> FederationManager.listen -> handleInbound, the same path a deployed coordinator uses — not a hand-rolled test-only TLS server).
  await a.store.fedListen("127.0.0.1", fedPort);
  await sleep(100);

  // --- Test 0: untrusted inbound connection is rejected ---
  console.log("\nTest 0: untrusted connection is rejected...");
  await assert.rejects(
    () => b.store.fedConnect("127.0.0.1", fedPort),
    /rejected|not in the trusted-fingerprint allowlist/i,
    "Connecting before either side has pinned the other's fingerprint should be rejected",
  );
  assert.strictEqual(
    b.store.fedLinks().length,
    0,
    "B should have no federation links after a rejected attempt",
  );
  console.log("  Rejected as expected — no link was created.");

  // --- Pin fingerprints on both sides, mirroring what an operator does out of band ---
  console.log("\nPinning fingerprints on both sides...");
  const fingerprintA = a.store.getFederationFingerprint();
  const fingerprintB = b.store.getFederationFingerprint();
  assert.ok(fingerprintA.length > 0, "A should report its own fingerprint");
  assert.ok(fingerprintB.length > 0, "B should report its own fingerprint");
  await a.store.fedTrust(fingerprintB);
  await b.store.fedTrust(fingerprintA);
  assert.deepStrictEqual(a.store.fedTrustedFingerprints(), [fingerprintB]);
  assert.deepStrictEqual(b.store.fedTrustedFingerprints(), [fingerprintA]);

  // --- Test 1: Establish federation link now that both sides trust each other ---
  console.log("\nTest 1: Establish federation link...");
  const linkId = await b.store.fedConnect("127.0.0.1", fedPort);
  console.log(`  Link established: ${linkId}`);
  assert.ok(linkId, "Should return a link ID");

  const linksB = b.store.fedLinks();
  assert.strictEqual(linksB.length, 1, "B should have 1 federation link");
  const link = linksB[0];
  assert.ok(link, "Link should exist");
  assert.ok(link.remoteMeshId.length > 0, "Remote mesh ID should be present");

  await sleep(200);

  // --- Test 2: Agent presence propagates ---
  console.log("Test 2: Agent presence propagates...");
  const agentsB = await b.store.listAgents(b.store.peerId);
  console.log(`  B sees ${String(agentsB.length)} agent(s)`);
  const fedAgentsB = agentsB.filter((ag) => ag.tags.includes("federated"));
  assert.ok(
    fedAgentsB.length >= 1,
    "B should see at least 1 federated agent from A",
  );

  const agentsA = await a.store.listAgents(a.store.peerId);
  console.log(`  A sees ${String(agentsA.length)} agent(s)`);
  const fedAgentsA = agentsA.filter((ag) => ag.tags.includes("federated"));
  assert.ok(
    fedAgentsA.length >= 1,
    "A should see at least 1 federated agent from B",
  );

  // --- Test 3: Federated room messages propagate ---
  console.log("Test 3: Federated room messages propagate...");

  const fedRoomId = `fed-room-${String(Date.now())}`;
  const fedRoom = await a.store.createRoom({
    name: fedRoomId,
    type: "public",
    owner: a.store.peerId,
    description: "Federated test room",
    federated: true,
  });
  console.log(`  Created federated room: ${fedRoom.id}`);
  await sleep(200);

  // Federation matches a room across the two separate meshes by literal id equality (handleFedRoomMessage/Join/Leave all key off the incoming roomId string directly) -- an owner-rooted path only coincides on both sides when both sides construct it from the same owner, so B's mirror of A's room is created with A's own peerId as owner, not B's.
  const fedRoomB = await b.store.createRoom({
    name: fedRoomId,
    type: "public",
    owner: a.store.peerId,
    description: "Federated test room",
    federated: true,
  });
  console.log(`  Created matching federated room on B: ${fedRoomB.id}`);
  // createRoom's default members is [owner] -- since owner is A's peerId (to make the id match), B's own local agent must explicitly join its mirror for handleFedRoomMessage's local-delivery loop to reach it.
  await b.store.joinRoom(fedRoomB.id, b.store.peerId);
  await sleep(200);

  a.deliveries.length = 0;
  b.deliveries.length = 0;

  const msg = await a.store.sendRoomMessage(
    fedRoom.id,
    a.store.peerId,
    "Hello from mesh A!",
  );
  console.log(`  A sent: "${msg.content}"`);
  await sleep(500);

  const fedMsgs = b.deliveries.filter(
    (e) =>
      e.type === "room_message" && e.message.content === "Hello from mesh A!",
  );
  console.log(`  B received ${String(fedMsgs.length)} federated message(s)`);
  assert.ok(fedMsgs.length >= 1, "B should receive the federated room message");

  // --- Test 4: Non-federated rooms are isolated ---
  console.log("Test 4: Non-federated rooms are isolated...");

  const localRoomId = `local-room-${String(Date.now())}`;
  console.log(`  Creating non-federated room: ${localRoomId}`);
  const localRoom = await a.store.createRoom({
    name: localRoomId,
    type: "public",
    owner: a.store.peerId,
    description: "Local-only room",
    // federated defaults to false
  });
  console.log(
    `  Created non-federated room: ${localRoom.id}, federated=${String(localRoom.federated)}`,
  );
  await sleep(100);

  b.deliveries.length = 0;

  console.log("  Sending message in non-federated room...");
  await a.store.sendRoomMessage(
    localRoom.id,
    a.store.peerId,
    "Secret local message",
  );
  console.log("  Message sent.");
  await sleep(100);

  const leakedMsgs = b.deliveries.filter(
    (e) =>
      e.type === "room_message" && e.message.content === "Secret local message",
  );
  console.log(`  B received ${String(leakedMsgs.length)} leaked message(s)`);
  assert.strictEqual(
    leakedMsgs.length,
    0,
    "B should NOT receive non-federated room messages",
  );

  // --- Test 5: Federation link listing ---
  console.log("Test 5: Federation link listing...");
  const linksA = a.store.fedLinks();
  assert.strictEqual(linksA.length, 1, "A should have 1 federation link");
  console.log(`  A links: ${linksA.map((l) => l.remoteName).join(", ")}`);

  // --- Test 6: Disconnect federation link ---
  console.log("Test 6: Disconnect federation link...");
  await b.store.fedDisconnect(linkId);
  await sleep(200);

  const linksAfter = b.store.fedLinks();
  assert.strictEqual(
    linksAfter.length,
    0,
    "B should have 0 federation links after disconnect",
  );

  // --- Cleanup ---
  console.log("\nCleaning up...");
  await a.store.fedStopListening();
  await a.store.shutdown();
  await b.store.shutdown();

  console.log("\n✓ All federation tests passed!");
}

main().catch((err: unknown) => {
  console.error("Test failed:", err);
  process.exit(1);
});

/**
 * Federation integration test — verifies that two MeshStore instances on
 * different "machines" (simulated via separate TCP meshes) can federate
 * through coordinator-to-coordinator TLS links.
 *
 * Tests:
 *   1. Establish federation link between two meshes
 *   2. Agent presence propagates across federation
 *   3. Messages in federated rooms propagate across federation
 *   4. Non-federated rooms are isolated (messages never cross)
 *
 * Run: node dist/test/federation.integration.test.js
 */

import { MeshStore } from "../core/mesh-store.js";
import type { DeliveryEvent, RoomMessage } from "../core/types.js";
import * as assert from "node:assert/strict";
import * as net from "node:net";

// Use high ports to avoid collisions with real meshes
const MESH_A_PORT = 28876;
const MESH_B_PORT = 28877;
const FED_PORT_A = 28878;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a mesh store that also listens on a second port for federation
 * inbound connections. Returns the store and the federation listener port.
 */
async function createMesh(
  name: string,
  coordinatorPort: number,
): Promise<{
  store: MeshStore;
  deliveries: DeliveryEvent[];
}> {
  const store = new MeshStore(coordinatorPort);
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

/**
 * Find a free port on localhost.
 */
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

  // Create two separate meshes (simulating two machines)
  console.log("Creating mesh A (coordinator)...");
  const a = await createMesh("mesh-a-agent", MESH_A_PORT);
  await sleep(100);

  console.log("Creating mesh B (coordinator)...");
  const b = await createMesh("mesh-b-agent", MESH_B_PORT);
  await sleep(100);

  // Find a free port for the federation server
  const fedPort = await findFreePort();
  console.log(`Using federation port ${String(fedPort)}`);

  // Start a TLS federation server on mesh A that the FederationManager
  // can accept connections on. We use the federation manager's TLS identity.
  const fedServer = await startFedServer(
    a.store.federation.tlsIdentity,
    fedPort,
    a.store,
  );
  await sleep(100);

  // --- Test 1: Establish federation link ---
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
  // After federation, B should see A's agent as a federated agent
  const agentsB = await b.store.listAgents(b.store.peerId);
  console.log(`  B sees ${String(agentsB.length)} agent(s)`);
  const fedAgentsB = agentsB.filter((ag) => ag.tags.includes("federated"));
  assert.ok(
    fedAgentsB.length >= 1,
    "B should see at least 1 federated agent from A",
  );

  // A should see B's agent as a federated agent
  const agentsA = await a.store.listAgents(a.store.peerId);
  console.log(`  A sees ${String(agentsA.length)} agent(s)`);
  const fedAgentsA = agentsA.filter((ag) => ag.tags.includes("federated"));
  assert.ok(
    fedAgentsA.length >= 1,
    "A should see at least 1 federated agent from B",
  );

  // --- Test 3: Federated room messages propagate ---
  console.log("Test 3: Federated room messages propagate...");

  // Create a federated room on mesh A
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

  // Create the same federated room on mesh B (same ID)
  const fedRoomB = await b.store.createRoom({
    name: fedRoomId,
    type: "public",
    owner: b.store.peerId,
    description: "Federated test room",
    federated: true,
  });
  console.log(`  Created matching federated room on B: ${fedRoomB.id}`);
  await sleep(200);

  // Clear deliveries
  a.deliveries.length = 0;
  b.deliveries.length = 0;

  // Send a message from A's agent in the federated room
  const msg = await a.store.sendRoomMessage(
    fedRoom.id,
    a.store.peerId,
    "Hello from mesh A!",
  );
  console.log(`  A sent: "${msg.content}"`);
  await sleep(500);

  // B should receive the federated message
  const fedMsgs = b.deliveries.filter(
    (e) =>
      e.type === "room_message" && e.message.content === "Hello from mesh A!",
  );
  console.log(`  B received ${String(fedMsgs.length)} federated message(s)`);
  assert.ok(fedMsgs.length >= 1, "B should receive the federated room message");

  // --- Test 4: Non-federated rooms are isolated ---
  console.log("Test 4: Non-federated rooms are isolated...");

  // Create a non-federated room on mesh A
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

  // Clear deliveries
  b.deliveries.length = 0;

  // Send a message in the non-federated room
  console.log("  Sending message in non-federated room...");
  await a.store.sendRoomMessage(
    localRoom.id,
    a.store.peerId,
    "Secret local message",
  );
  console.log("  Message sent.");
  await sleep(100);

  // B should NOT receive this message
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
  fedServer.close();
  await a.store.shutdown();
  await b.store.shutdown();

  console.log("\n✓ All federation tests passed!");
}

// ---------------------------------------------------------------------------
// Federation TLS server (simulates coordinator-to-coordinator link)
// ---------------------------------------------------------------------------

import * as tls from "node:tls";
import type { PeerIdentity } from "../core/identity.js";
import { encode, isMeshMessage, MessageBuffer } from "../core/wire-protocol.js";
import type { MeshMessage } from "../core/wire-protocol.js";

/**
 * Start a simple TLS server that accepts federation connections and
 * delegates them to the FederationManager on the given store.
 */
function startFedServer(
  identity: PeerIdentity,
  port: number,
  store: MeshStore,
): Promise<tls.Server> {
  return new Promise((resolve, reject) => {
    const server = tls.createServer(
      {
        key: identity.privateKey,
        cert: identity.certificate,
        rejectUnauthorized: false,
        requestCert: true,
      },
      (socket) => {
        // Delegate to the FederationManager's inbound handler
        void store.federation.handleInbound(socket).catch((err: unknown) => {
          console.error("Fed inbound error:", err);
          socket.destroy();
        });
      },
    );

    server.listen(port, "127.0.0.1", () => {
      resolve(server);
    });

    server.on("error", reject);
  });
}

main().catch((err: unknown) => {
  console.error("Test failed:", err);
  process.exit(1);
});

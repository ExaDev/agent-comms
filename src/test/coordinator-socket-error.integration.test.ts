/**
 * Test for coordinator socket error handling.
 *
 * Verifies that handleCoordinatorConnection has an error listener
 * so ECONNRESET and other socket errors don't crash the process.
 */

import * as net from "node:net";
import { MeshStore } from "../core/mesh-store.js";
import * as assert from "node:assert/strict";
import { test } from "node:test";

const TEST_PORT = 19879;

/**
 * When a peer connects to the coordinator and then abruptly resets
 * the connection (ECONNRESET), the coordinator process must not crash.
 *
 * Before the fix, handleCoordinatorConnection attached .on("close") and
 * .on("data") but no .on("error"), so an ECONNRESET became an unhandled
 * error event on the socket → uncaught exception → process crash.
 */
void test("coordinator survives ECONNRESET on accepted socket", async () => {
  const store = new MeshStore(TEST_PORT);
  await store.init();

  // Connect a raw socket to the coordinator port
  const socket = net.createConnection({
    port: TEST_PORT,
    host: "127.0.0.1",
  });

  await new Promise<void>((resolve) => {
    socket.on("connect", resolve);
  });

  // Send RST instead of FIN — triggers ECONNRESET on the server socket
  socket.resetAndDestroy();

  // Give the server time to process the error event
  await new Promise((resolve) => setTimeout(resolve, 300));

  // If we reach here, the process didn't crash from the unhandled error.
  // Verify the store is still functional.
  const agents = await store.listAgents(store.peerId);
  assert.ok(Array.isArray(agents), "Store should still be functional");

  await store.shutdown();
});

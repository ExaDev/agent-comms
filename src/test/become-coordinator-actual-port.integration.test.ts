/**
 * becomeCoordinator/addListener actual-port regression test (#42) — becomeCoordinator(host, 0) and addListener(host, 0, policy) must report the OS-assigned port they actually bound, not the literal 0 they were called with, on every transport whose listener bookkeeping goes through listListeners().
 *
 * Run directly with a specific scenario name as an argument, or with none to run every scenario in order.
 */

import * as assert from "node:assert/strict";
import { createTlsTransport } from "@exadev/wire-mesh-core/adapters/tls-transport";
import { acceptMeshSession } from "@exadev/wire-mesh-core/domain/mesh-session";
import { WireMeshTransport, DOMAIN } from "../core/wire-mesh-transport.js";
import { generateIdentity } from "../core/identity.js";
import { toIdentityPort } from "../core/wire-mesh-identity.js";
import type { TransportEvents } from "../core/transport.js";

function noopEvents(): TransportEvents {
  return {
    onMessage: () => undefined,
    onPeerConnected: () => undefined,
    onPeerDisconnected: () => undefined,
    onIntroduction: () => undefined,
    onConnectionRequest: () => undefined,
    onPeerList: () => undefined,
    onPeerJoined: () => undefined,
    onBecomeCoordinator: () => undefined,
  };
}

/** Connects a real client session to the given port to confirm it's genuinely live, not merely non-zero. */
async function connectAndClose(port: number): Promise<void> {
  const clientIdentity = generateIdentity();
  const clientTransport = createTlsTransport({
    certificatePem: clientIdentity.certificate,
    privateKeyPem: clientIdentity.privateKey,
  });
  const connection = await clientTransport.connect(`127.0.0.1:${String(port)}`);
  const clientIdentityPort = await toIdentityPort(clientIdentity);
  const session = await acceptMeshSession(connection, clientIdentityPort, [
    DOMAIN,
  ]);
  await session.close();
}

async function testBecomeCoordinatorReportsActualPort(): Promise<void> {
  const identity = generateIdentity();
  const transport = new WireMeshTransport(noopEvents(), identity);

  await transport.becomeCoordinator("127.0.0.1", 0);
  const [listener] = transport.listListeners();
  assert.ok(listener);
  assert.notStrictEqual(listener.port, 0);

  await connectAndClose(listener.port);
  console.log(
    `  ✓ becomeCoordinator reported and bound the same port (${listener.port})`,
  );

  await transport.shutdown();
}

async function testAddListenerReportsActualPort(): Promise<void> {
  const identity = generateIdentity();
  const transport = new WireMeshTransport(noopEvents(), identity);
  await transport.becomeCoordinator("127.0.0.1", 0);

  const id = await transport.addListener("127.0.0.1", 0, "observe");
  const added = transport.listListeners().find((l) => l.id === id);
  assert.ok(added);
  assert.notStrictEqual(added.port, 0);

  await connectAndClose(added.port);
  console.log(
    `  ✓ addListener reported and bound the same port (${added.port})`,
  );

  await transport.shutdown();
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const testName = process.argv[2];

const tests: Record<string, () => Promise<void>> = {
  "become-coordinator-reports-actual-port":
    testBecomeCoordinatorReportsActualPort,
  "add-listener-reports-actual-port": testAddListenerReportsActualPort,
};

const selected =
  testName === undefined
    ? Object.entries(tests)
    : Object.entries(tests).filter(([name]) => name === testName);
if (selected.length === 0) {
  console.error(`Unknown test: ${testName}`);
  console.error(`Available: ${Object.keys(tests).join(", ")}`);
  process.exit(1);
}

async function run(): Promise<void> {
  for (const [name, fn] of selected) {
    console.log(`Running ${name}:`);
    await fn();
  }

  const maxWait = 2000;
  const start = Date.now();
  while (
    ((
      process as unknown as { _getActiveHandles?: () => unknown[] }
    )._getActiveHandles?.()?.length ?? 0) > 0 &&
    Date.now() - start < maxWait
  ) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  process.exit(0);
}

run().catch((err: unknown) => {
  console.error(`FAIL [${testName ?? "all"}]:`, err);
  process.exit(1);
});

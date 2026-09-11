/**
 * becomeCoordinator actual-port regression test (#42) — becomeCoordinator(host, 0) must report the OS-assigned port it actually bound, not the literal 0 it was called with, on every transport whose listener bookkeeping goes through listListeners().
 *
 * Run: node dist/test/become-coordinator-actual-port.integration.test.js [test-name] With no argument, every scenario runs in order.
 */

import * as tls from "node:tls";
import * as assert from "node:assert/strict";
import { TlsTransport } from "../core/tls-transport.js";
import { generateIdentity } from "../core/identity.js";
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

async function testTlsReportsActualPort(): Promise<void> {
  const identity = generateIdentity();
  const transport = new TlsTransport(noopEvents(), identity);

  await transport.becomeCoordinator("127.0.0.1", 0);
  const [listener] = transport.listListeners();
  assert.ok(listener);
  assert.notStrictEqual(listener.port, 0);

  await new Promise<void>((resolve, reject) => {
    const socket = tls.connect(
      { host: "127.0.0.1", port: listener.port, rejectUnauthorized: false },
      () => {
        socket.destroy();
        resolve();
      },
    );
    socket.once("error", reject);
  });
  console.log(
    `  ✓ TlsTransport reported and bound the same port (${listener.port})`,
  );

  await transport.shutdown();
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const testName = process.argv[2];

const tests: Record<string, () => Promise<void>> = {
  "tls-reports-actual-port": testTlsReportsActualPort,
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

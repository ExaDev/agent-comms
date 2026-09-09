/**
 * Peer ID verification integration test (#40) — a socket claiming a peer ID that doesn't match the certificate it actually presents must be rejected, on every path where TlsTransport learns a remote peer's identity from a self-reported wire message: the coordinator's `introduce` handler, the data server's `pong` handler, and the client's own `connectToPeer` dial.
 *
 * Run: node dist/test/peer-id-verification.integration.test.js [test-name] With no argument, every scenario runs in order.
 */

import * as net from "node:net";
import * as tls from "node:tls";
import * as assert from "node:assert/strict";
import { TlsTransport } from "../core/tls-transport.js";
import { generateIdentity } from "../core/identity.js";
import { encode } from "../core/wire-protocol.js";
import type { PeerInfo } from "../core/wire-protocol.js";
import type { TransportEvents } from "../core/transport.js";

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

function noopEvents(overrides: Partial<TransportEvents> = {}): TransportEvents {
  return {
    onMessage: () => undefined,
    onPeerConnected: () => undefined,
    onPeerDisconnected: () => undefined,
    onIntroduction: () => undefined,
    onConnectionRequest: () => undefined,
    onPeerList: () => undefined,
    onPeerJoined: () => undefined,
    onBecomeCoordinator: () => undefined,
    ...overrides,
  };
}

async function testSpoofedIntroduceRejected(): Promise<void> {
  const identityCoordinator = generateIdentity();
  const identityAttacker = generateIdentity();

  let introduced = false;
  let sawError = false;
  const transport = new TlsTransport(
    noopEvents({
      onIntroduction: () => {
        introduced = true;
      },
      onError: () => {
        sawError = true;
      },
    }),
    identityCoordinator,
  );
  const port = await allocFreePort();
  await transport.becomeCoordinator("127.0.0.1", port);

  // The attacker connects with its own genuine certificate, but sends an `introduce` claiming the coordinator's own peer ID — self-reported identity that doesn't match the certificate on this connection.
  const socket = tls.connect({
    key: identityAttacker.privateKey,
    cert: identityAttacker.certificate,
    host: "127.0.0.1",
    port,
    rejectUnauthorized: false,
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("secureConnect", () => {
      socket.write(
        encode({
          method: "introduce",
          peerId: identityCoordinator.fingerprint,
          dataPort: 12345,
        }),
      );
      resolve();
    });
    socket.once("error", reject);
  });

  await sleep(300);

  assert.strictEqual(
    introduced,
    false,
    "onIntroduction must not fire for a spoofed peer ID",
  );
  assert.ok(sawError, "the rejection should be reported via onError");
  assert.ok(socket.destroyed, "the spoofing socket should be destroyed");

  await transport.shutdown();
  console.log("  ✓ introduce with mismatched certificate is rejected");
}

async function testSpoofedPongRejected(): Promise<void> {
  const identityListener = generateIdentity();
  const identityAttacker = generateIdentity();

  let connected = false;
  let sawError = false;
  const transport = new TlsTransport(
    noopEvents({
      onPeerConnected: () => {
        connected = true;
      },
      onError: () => {
        sawError = true;
      },
    }),
    identityListener,
  );
  await transport.startDataServer();

  // The attacker connects to the data server with its own certificate, but sends a `pong` claiming an arbitrary, unrelated peer ID.
  const socket = tls.connect({
    key: identityAttacker.privateKey,
    cert: identityAttacker.certificate,
    host: "127.0.0.1",
    port: transport.dataPort,
    rejectUnauthorized: false,
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("secureConnect", () => {
      socket.write(encode({ method: "pong", peerId: "NOT-MY-CERTIFICATE" }));
      resolve();
    });
    socket.once("error", reject);
  });

  await sleep(300);

  assert.strictEqual(
    connected,
    false,
    "onPeerConnected must not fire for a spoofed peer ID",
  );
  assert.ok(sawError, "the rejection should be reported via onError");
  assert.ok(socket.destroyed, "the spoofing socket should be destroyed");

  await transport.shutdown();
  console.log("  ✓ pong with mismatched certificate is rejected");
}

async function testConnectToPeerCertMismatchRejected(): Promise<void> {
  // The real peer B is listening under its own genuine identity...
  const identityB = generateIdentity();
  const transportB = new TlsTransport(noopEvents(), identityB);
  await transportB.startDataServer();

  // ...but the peer list entry a compromised or misbehaving coordinator could hand to a dialling client claims a completely different ID for that same host:port.
  const claimedPeer: PeerInfo = {
    id: "CLAIMED-BUT-WRONG-ID",
    port: transportB.dataPort,
    startedAt: new Date().toISOString(),
  };

  let sawError = false;
  const identityDialer = generateIdentity();
  const transportDialer = new TlsTransport(
    noopEvents({
      onError: () => {
        sawError = true;
      },
    }),
    identityDialer,
  );

  await transportDialer.connectToPeer(claimedPeer, identityDialer.fingerprint);
  await sleep(200);

  assert.ok(
    sawError,
    "the rejection should be reported via onError when the dialled peer's certificate doesn't match the claimed ID",
  );
  await assert.rejects(
    () =>
      transportDialer.send(
        { id: claimedPeer.id },
        { method: "pong", peerId: identityDialer.fingerprint },
      ),
    /No connection for handle/,
    "no peer connection should have been registered under the falsely claimed ID",
  );

  await transportDialer.shutdown();
  await transportB.shutdown();
  console.log(
    "  ✓ connectToPeer rejects a certificate that doesn't match the claimed peer ID",
  );
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const testName = process.argv[2];

const tests: Record<string, () => Promise<void>> = {
  "spoofed-introduce-rejected": testSpoofedIntroduceRejected,
  "spoofed-pong-rejected": testSpoofedPongRejected,
  "connect-to-peer-cert-mismatch-rejected":
    testConnectToPeerCertMismatchRejected,
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

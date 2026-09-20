/**
 * becomeCoordinator/addListener actual-port regression test (#42) — becomeCoordinator(host, 0) and addListener(host, 0, policy) must report the OS-assigned port they actually bound, not the literal 0 they were called with, on every transport whose listener bookkeeping goes through listListeners().
 */

import { test, expect } from "vitest";
import { createTlsTransport } from "wire-mesh-core/adapters/tls-transport";
import { acceptMeshSession } from "wire-mesh-core/domain/mesh-session";
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
    onRevocationAnnounce: () => undefined,
    onPresenceAdvert: () => undefined,
    onDeviceReachable: () => undefined,
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
  expect(listener).toBeTruthy();
  if (listener === undefined) throw new Error("expected a bound listener");
  expect(listener.port).not.toBe(0);

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
  expect(added).toBeTruthy();
  if (added === undefined) throw new Error("expected the added listener");
  expect(added.port).not.toBe(0);

  await connectAndClose(added.port);
  console.log(
    `  ✓ addListener reported and bound the same port (${added.port})`,
  );

  await transport.shutdown();
}

test("become-coordinator-reports-actual-port", async () => {
  await testBecomeCoordinatorReportsActualPort();
});

test("add-listener-reports-actual-port", async () => {
  await testAddListenerReportsActualPort();
});

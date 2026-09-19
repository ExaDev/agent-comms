/**
 * WireMeshTransport's data-domain frame responder: wires handleDataHave/handleDataRequest/handleDataEntries into every session's own frame stream (via acceptMeshSession's onFrame hook, wire-mesh#102), so a real data-have -\> data-request -\> data-entries exchange actually completes over a live connection. This is the "peers can exchange sync frames" half of agent-comms#50's P5 integration; sendDataFrame is a deliberately mechanical send primitive (send this exact frame to this known peer) -- deciding WHEN to call it (the catch-up policy) is still its own separate, open piece, so this test plays that role explicitly rather than assuming it.
 */

import { test, describe, expect } from "vitest";
import { generateIdentity } from "../core/identity.js";
import { toIdentityPort } from "../core/wire-mesh-identity.js";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { createMemoryStorage } from "wire-mesh-core/adapters/memory-storage";
import { appendOwnEntry, readEntries } from "wire-mesh-core/domain/data-sync";
import { WireMeshTransport } from "../core/wire-mesh-transport.js";
import type { ConnectionHandle, TransportEvents } from "../core/transport.js";
import { waitFor } from "./test-transport.js";

const WAIT_FOR_ASYNC_TIMEOUT_MS = 20_000;
const WAIT_FOR_ASYNC_POLL_INTERVAL_MS = 20;

/** waitFor's own async-condition counterpart -- test-transport.ts's waitFor requires a synchronous condition() by design, but this file's own condition (a real KeyValueStorage read) is unavoidably async. Same poll-until-true-or-timeout shape, generous timeout, descriptive error on timeout. */
async function waitForAsync(
  condition: () => Promise<boolean>,
  description: string,
  timeoutMs = WAIT_FOR_ASYNC_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) {
      throw new Error(
        `waitForAsync timed out after ${String(timeoutMs)}ms: ${description}`,
      );
    }
    await new Promise((resolve) => {
      setTimeout(resolve, WAIT_FOR_ASYNC_POLL_INTERVAL_MS);
    });
  }
}

function inertEvents(): TransportEvents {
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
  };
}

describe("WireMeshTransport data-domain frame responder", () => {
  test("a data-have kicks off a real data-request/data-entries exchange that lands the entry in the peer's own storage", async () => {
    const identityA = generateIdentity();
    const identityB = generateIdentity();
    const peerIdA = deviceIdToHex(
      await toIdentityPort(identityA).then((p) => p.deviceId),
    );
    const peerIdB = deviceIdToHex(
      await toIdentityPort(identityB).then((p) => p.deviceId),
    );

    const storageA = createMemoryStorage();
    const storageB = createMemoryStorage();
    const identityPortA = await toIdentityPort(identityA);

    const { haveFrame } = await appendOwnEntry(
      { identity: identityPortA, storage: storageA },
      new TextEncoder().encode("catch-up-able message"),
    );

    const transportA = new WireMeshTransport(inertEvents(), identityA, {
      dataStorage: storageA,
    });
    const transportB = new WireMeshTransport(inertEvents(), identityB, {
      dataStorage: storageB,
    });

    try {
      await transportA.startDataServer();
      await transportB.connectToPeer(
        {
          id: peerIdA,
          port: transportA.dataPort,
          startedAt: new Date().toISOString(),
        },
        peerIdB,
      );

      await waitFor(
        () => transportA.listKnownDevices().length > 0,
        "A's session with B is fully established",
      );

      await transportA.sendDataFrame(peerIdB, haveFrame);

      await waitForAsync(async () => {
        const entries = await readEntries(storageB, identityPortA.deviceId, 0);
        return entries.length === 1;
      }, "B's own storage receives A's entry via the data-have/data-request/data-entries exchange");

      const [entry] = await readEntries(storageB, identityPortA.deviceId, 0);
      expect(entry).toBeDefined();
      if (entry === undefined) return;
      expect(new TextDecoder().decode(entry)).toBe("catch-up-able message");
    } finally {
      await transportB.shutdown();
      await transportA.shutdown();
    }
  });

  test("a session with no dataStorage configured never responds to a data-have", async () => {
    const identityA = generateIdentity();
    const identityB = generateIdentity();
    const peerIdA = deviceIdToHex(
      await toIdentityPort(identityA).then((p) => p.deviceId),
    );
    const peerIdB = deviceIdToHex(
      await toIdentityPort(identityB).then((p) => p.deviceId),
    );

    const storageA = createMemoryStorage();
    const identityPortA = await toIdentityPort(identityA);
    const { haveFrame } = await appendOwnEntry(
      { identity: identityPortA, storage: storageA },
      new TextEncoder().encode("hello"),
    );

    const transportA = new WireMeshTransport(inertEvents(), identityA, {
      dataStorage: storageA,
    });
    // No dataStorage passed for B -- the exact configuration every construction site that predates this feature has.
    const transportB = new WireMeshTransport(inertEvents(), identityB);

    try {
      await transportA.startDataServer();
      await transportB.connectToPeer(
        {
          id: peerIdA,
          port: transportA.dataPort,
          startedAt: new Date().toISOString(),
        },
        peerIdB,
      );

      await waitFor(
        () => transportA.listKnownDevices().length > 0,
        "A's session with B is fully established",
      );

      // Sends without throwing -- the real risk this test guards against is B's own handleDataFrame crashing (e.g. dereferencing an undefined dataStorage) rather than simply declining to respond. B has no dataStorage configured at all, so there is no storage object of its own left to inspect afterwards; not crashing is the whole property under test.
      await expect(
        transportA.sendDataFrame(peerIdB, haveFrame),
      ).resolves.toBeUndefined();

      // Long enough to comfortably span a real exchange were one wired up, short enough to keep the test fast.
      const SETTLE_MS = 200;
      await new Promise((resolve) => {
        setTimeout(resolve, SETTLE_MS);
      });
    } finally {
      await transportB.shutdown();
      await transportA.shutdown();
    }
  });
});

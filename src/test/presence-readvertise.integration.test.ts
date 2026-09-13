/**
 * P4 presence: WireMeshTransport's periodic self-advert re-send (readvertisePresence) and its counterpart on the receiving side (reportPresenceAdvert -> TransportEvents.onPresenceAdvert). Constructed directly against two real WireMeshTransport instances joined by a genuine data connection, deliberately bypassing MeshStore -- MeshStore's own updateAgent already propagates a status change via the pre-existing broadcastPatch/broadcast() path (P3.8 has not retired that yet), which would make a MeshStore-level test unable to tell whether presence gossip specifically worked, as opposed to the older mechanism that still runs alongside it.
 */

import * as assert from "node:assert/strict";
import { test, describe } from "node:test";
import { generateIdentity } from "../core/identity.js";
import { toIdentityPort } from "../core/wire-mesh-identity.js";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { WireMeshTransport } from "../core/wire-mesh-transport.js";
import type { ConnectionHandle, TransportEvents } from "../core/transport.js";
import type { AgentStatus } from "../core/types.js";
import { waitFor } from "./test-transport.js";

const SHORT_PRESENCE_INTERVAL_MS = 50;

function eventsRecordingPresence(
  onPresence: (handle: ConnectionHandle, status: AgentStatus) => void,
): TransportEvents {
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
    onPresenceAdvert: onPresence,
  };
}

describe("WireMeshTransport presence re-advertisement", () => {
  void test("a session periodically re-sends this side's presence, and the peer surfaces it via onPresenceAdvert", async () => {
    const identityA = generateIdentity();
    const identityB = generateIdentity();
    const peerIdA = deviceIdToHex(
      await toIdentityPort(identityA).then((p) => p.deviceId),
    );
    const peerIdB = deviceIdToHex(
      await toIdentityPort(identityB).then((p) => p.deviceId),
    );

    const presenceSeenByB: { handle: ConnectionHandle; status: AgentStatus }[] =
      [];
    let currentStatusA: AgentStatus = "active";

    const transportA = new WireMeshTransport(
      eventsRecordingPresence(() => undefined),
      identityA,
      undefined,
      undefined,
      () => currentStatusA,
      SHORT_PRESENCE_INTERVAL_MS,
    );
    const transportB = new WireMeshTransport(
      eventsRecordingPresence((handle, status) => {
        presenceSeenByB.push({ handle, status });
      }),
      identityB,
    );

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
        () => presenceSeenByB.some((seen) => seen.status === "active"),
        "B observes A's initial active presence",
      );

      currentStatusA = "idle";

      await waitFor(
        () => presenceSeenByB.some((seen) => seen.status === "idle"),
        "B observes A's updated idle presence after the next re-advertisement tick",
      );

      const idleSighting = presenceSeenByB.find(
        (seen) => seen.status === "idle",
      );
      assert.equal(idleSighting?.handle.id, peerIdA);
    } finally {
      await transportB.shutdown();
      await transportA.shutdown();
    }
  });

  void test("a session with no presence source configured never re-advertises", async () => {
    const identityA = generateIdentity();
    const identityB = generateIdentity();
    const peerIdA = deviceIdToHex(
      await toIdentityPort(identityA).then((p) => p.deviceId),
    );
    const peerIdB = deviceIdToHex(
      await toIdentityPort(identityB).then((p) => p.deviceId),
    );

    const presenceSeenByB: { handle: ConnectionHandle; status: AgentStatus }[] =
      [];

    // No getCurrentPresence argument at all -- every construction site that predates this feature, and the exact configuration this test exists to prove stays inert rather than accidentally advertising a stale or default status.
    const transportA = new WireMeshTransport(
      eventsRecordingPresence(() => undefined),
      identityA,
    );
    const transportB = new WireMeshTransport(
      eventsRecordingPresence((handle, status) => {
        presenceSeenByB.push({ handle, status });
      }),
      identityB,
    );

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

      // Long enough to comfortably span several presence-readvertise ticks were one wired up (SHORT_PRESENCE_INTERVAL_MS above), short enough to keep the test fast -- the assertion below is a genuine "nothing happened", not a race against a real event we're waiting to observe.
      await new Promise((resolve) =>
        setTimeout(resolve, SHORT_PRESENCE_INTERVAL_MS * 3),
      );
      assert.equal(presenceSeenByB.length, 0);
    } finally {
      await transportB.shutdown();
      await transportA.shutdown();
    }
  });
});

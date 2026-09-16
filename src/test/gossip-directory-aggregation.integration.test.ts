/**
 * WireMeshTransport's mesh-wide gossip directory aggregation: listKnownDevices() merges every live session's own peer-advert directory into one device-id-keyed view, so a consumer (agent listing, room discovery) can read every device this side has heard gossip from without reaching into per-session internals. This is the prerequisite P3.8's own room-discovery design and the eventual agent register/update/offline retirement both named as missing and blocking (agent-comms#48's own issue body, 2026-09-14 investigation) -- built here as its own foundational primitive, tested directly against real WireMeshTransport instances the same way presence-readvertise.integration.test.ts already does, deliberately bypassing MeshStore for the same reason that file gives.
 */

import { test, describe, expect } from "vitest";
import { generateIdentity } from "../core/identity.js";
import { toIdentityPort } from "../core/wire-mesh-identity.js";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { WireMeshTransport } from "../core/wire-mesh-transport.js";
import type { ConnectionHandle, TransportEvents } from "../core/transport.js";
import { waitFor } from "./test-transport.js";

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

describe("WireMeshTransport.listKnownDevices", () => {
  test("reflects a directly-connected peer's own gossiped advert, including its extension fields", async () => {
    const identityA = generateIdentity();
    const identityB = generateIdentity();
    const peerIdA = deviceIdToHex(
      await toIdentityPort(identityA).then((p) => p.deviceId),
    );
    const peerIdB = deviceIdToHex(
      await toIdentityPort(identityB).then((p) => p.deviceId),
    );

    const transportA = new WireMeshTransport(
      inertEvents(),
      identityA,
      undefined,
      undefined,
      () => "busy",
    );
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
        () =>
          transportB
            .listKnownDevices()
            .find((entry) => entry.deviceId === peerIdA)?.advert[
            "presence/status"
          ] === "busy",
        "B's known-devices view includes A's gossiped busy status",
      );

      const known = transportB
        .listKnownDevices()
        .find((entry) => entry.deviceId === peerIdA);
      expect(known?.advert["presence/status"]).toBe("busy");
    } finally {
      await transportB.shutdown();
      await transportA.shutdown();
    }
  });

  test("has no entries before any peer connects", () => {
    const identityA = generateIdentity();
    const transportA = new WireMeshTransport(inertEvents(), identityA);
    expect(transportA.listKnownDevices()).toEqual([]);
  });

  test("keeps the newest advert per device across repeated gossip re-advertisement", async () => {
    const identityA = generateIdentity();
    const identityB = generateIdentity();
    const peerIdA = deviceIdToHex(
      await toIdentityPort(identityA).then((p) => p.deviceId),
    );
    const peerIdB = deviceIdToHex(
      await toIdentityPort(identityB).then((p) => p.deviceId),
    );

    let currentStatusA: "active" | "idle" = "active";
    const SHORT_PRESENCE_INTERVAL_MS = 50;

    const transportA = new WireMeshTransport(
      inertEvents(),
      identityA,
      undefined,
      undefined,
      () => currentStatusA,
      SHORT_PRESENCE_INTERVAL_MS,
    );
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
        () =>
          transportB
            .listKnownDevices()
            .find((entry) => entry.deviceId === peerIdA)?.advert[
            "presence/status"
          ] === "active",
        "B first observes A's initial active status",
      );

      currentStatusA = "idle";

      await waitFor(
        () =>
          transportB
            .listKnownDevices()
            .find((entry) => entry.deviceId === peerIdA)?.advert[
            "presence/status"
          ] === "idle",
        "B's known-devices view converges on A's latest re-advertised status",
      );

      expect(
        transportB
          .listKnownDevices()
          .filter((entry) => entry.deviceId === peerIdA),
      ).toHaveLength(1);
    } finally {
      await transportB.shutdown();
      await transportA.shutdown();
    }
  });
});

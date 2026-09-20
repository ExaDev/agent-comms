/**
 * WireMeshTransport's own gossip self-advert now carries this side's own genuinely-reachable listener addresses (wire-mesh#38's own fork 2, "populate addresses from a real listener's own bound address" -- agent-comms is exactly the "real listen-and-dial consumer" that issue's own text names as the missing prerequisite). The default bootstrap coordinator listener always binds COORDINATOR_HOST (127.0.0.1, hardcoded, never configurable) -- useless to advertise to a remote peer -- so only listeners an operator explicitly registered via addListener (mesh_listen), which by construction represent a deliberate "make me reachable from elsewhere" declaration, are included.
 */

import { test, describe, expect } from "vitest";
import { generateIdentity } from "../core/identity.js";
import { toIdentityPort } from "../core/wire-mesh-identity.js";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { WireMeshTransport } from "../core/wire-mesh-transport.js";
import type { TransportEvents } from "../core/transport.js";
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
    onDeviceReachable: () => undefined,
  };
}

describe("WireMeshTransport listener-address gossip", () => {
  test("an operator-registered listener's address reaches a peer's directory via gossip", async () => {
    const identityA = generateIdentity();
    const identityB = generateIdentity();
    const peerIdA = deviceIdToHex(
      await toIdentityPort(identityA).then((p) => p.deviceId),
    );
    const peerIdB = deviceIdToHex(
      await toIdentityPort(identityB).then((p) => p.deviceId),
    );

    const transportA = new WireMeshTransport(inertEvents(), identityA);
    const transportB = new WireMeshTransport(inertEvents(), identityB);

    try {
      await transportA.startDataServer();
      await transportA.addListener("127.0.0.1", 0, "full");

      await transportB.connectToPeer(
        {
          id: peerIdA,
          port: transportA.dataPort,
          startedAt: new Date().toISOString(),
        },
        peerIdB,
      );

      await waitFor(() => {
        const advert = transportB
          .listKnownDevices()
          .find((entry) => entry.deviceId === peerIdA)?.advert;
        return (advert?.addresses.length ?? 0) > 0;
      }, "B observes A's advertised listener address");

      const known = transportB
        .listKnownDevices()
        .find((entry) => entry.deviceId === peerIdA);
      const [registered] = transportA.listListeners();
      expect(known?.advert.addresses).toEqual([
        `127.0.0.1:${String(registered?.port)}`,
      ]);
    } finally {
      await transportB.shutdown();
      await transportA.shutdown();
    }
  });

  test("the default bootstrap coordinator listener is never advertised (always loopback, useless to a remote peer)", async () => {
    const identityA = generateIdentity();
    const identityB = generateIdentity();
    const peerIdA = deviceIdToHex(
      await toIdentityPort(identityA).then((p) => p.deviceId),
    );
    const peerIdB = deviceIdToHex(
      await toIdentityPort(identityB).then((p) => p.deviceId),
    );

    const transportA = new WireMeshTransport(inertEvents(), identityA);
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
            .some((entry) => entry.deviceId === peerIdA),
        "B's known-devices view includes A",
      );

      const known = transportB
        .listKnownDevices()
        .find((entry) => entry.deviceId === peerIdA);
      expect(known?.advert.addresses).toEqual([]);
    } finally {
      await transportB.shutdown();
      await transportA.shutdown();
    }
  });
});

/**
 * WireMeshTransport's periodic gossip tick also carries this side's own currently-hosted public/private rooms (a `room/hosted` extension on peer-advert's own open tail, the same convention presence/status already established), so a peer's `listKnownDevices()` can read another device's advertised rooms without a bespoke per-fact event. This is the write side of P3.8's room-discovery replacement for createRoom's own broadcastPatch (agent-comms#48's own 2026-09-14 investigation): the read side (merging a gossip-discovered room into listRooms) is deliberately not built here -- it needs its own design pass, per that issue's established pattern, once this primitive exists to build it against.
 */

import { test, describe, expect } from "vitest";
import { generateIdentity } from "../core/identity.js";
import { toIdentityPort } from "../core/wire-mesh-identity.js";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import {
  WireMeshTransport,
  type HostedRoomAdvert,
} from "../core/wire-mesh-transport.js";
import type { TransportEvents } from "../core/transport.js";
import { waitFor } from "./test-transport.js";

const SHORT_INTERVAL_MS = 50;

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

describe("WireMeshTransport hosted-rooms gossip", () => {
  test("a peer's listKnownDevices reflects another device's currently-hosted public/private rooms", async () => {
    const identityA = generateIdentity();
    const identityB = generateIdentity();
    const peerIdA = deviceIdToHex(
      await toIdentityPort(identityA).then((p) => p.deviceId),
    );
    const peerIdB = deviceIdToHex(
      await toIdentityPort(identityB).then((p) => p.deviceId),
    );

    let hostedByA: readonly HostedRoomAdvert[] = [
      {
        path: `${peerIdA}/general`,
        name: "general",
        type: "public",
        description: "chat",
      },
    ];

    const transportA = new WireMeshTransport(
      inertEvents(),
      identityA,
      undefined,
      undefined,
      undefined,
      SHORT_INTERVAL_MS,
      () => hostedByA,
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

      await waitFor(() => {
        const advert = transportB
          .listKnownDevices()
          .find((entry) => entry.deviceId === peerIdA)?.advert["room/hosted"];
        return (
          Array.isArray(advert) &&
          advert.length === 1 &&
          (advert[0] as HostedRoomAdvert).name === "general"
        );
      }, "B observes A's advertised hosted room");

      hostedByA = [];

      await waitFor(() => {
        const advert = transportB
          .listKnownDevices()
          .find((entry) => entry.deviceId === peerIdA)?.advert["room/hosted"];
        return Array.isArray(advert) && advert.length === 0;
      }, "B observes A no longer hosting any room after the next tick");
    } finally {
      await transportB.shutdown();
      await transportA.shutdown();
    }
  });

  test("a session with no hosted-rooms source configured never advertises the room/hosted key", async () => {
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
      expect(known?.advert["room/hosted"]).toBeUndefined();
    } finally {
      await transportB.shutdown();
      await transportA.shutdown();
    }
  });
});

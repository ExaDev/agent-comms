/**
 * WireMeshTransport's periodic gossip tick also carries this side's own agent-identity self-advert (a `agent/self` extension on peer-advert's own open tail, the same convention presence/status and room/hosted already established), so a peer's `listKnownDevices()` can read another device's agent facts directly. This is the write half of P3.8's eventual agent register/update/offline retirement (agent-comms#48): the read side (merging a gossip-discovered agent into listAgents) is deliberately not built here -- it needs its own follow-up, per the room-discovery precedent (#131/#138) this mirrors.
 */

import { test, describe, expect } from "vitest";
import { generateIdentity } from "../core/identity.js";
import { toIdentityPort } from "../core/wire-mesh-identity.js";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { WireMeshTransport } from "../core/wire-mesh-transport.js";
import type { AgentSelfAdvert } from "../core/gossip-extensions.js";
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

describe("WireMeshTransport agent-self gossip", () => {
  test("a peer's listKnownDevices reflects another device's advertised agent identity", async () => {
    const identityA = generateIdentity();
    const identityB = generateIdentity();
    const peerIdA = deviceIdToHex(
      await toIdentityPort(identityA).then((p) => p.deviceId),
    );
    const peerIdB = deviceIdToHex(
      await toIdentityPort(identityB).then((p) => p.deviceId),
    );

    const selfAdvert: AgentSelfAdvert = {
      name: "agent-a",
      harness: "pi",
      cwd: "/tmp/a",
      pid: 4242,
      startedAt: "2026-01-01T00:00:00.000Z",
      tags: ["from-a"],
      subscribedRooms: [],
    };

    const transportA = new WireMeshTransport(inertEvents(), identityA, {
      presenceReadvertiseIntervalMs: SHORT_INTERVAL_MS,
      getSelfAgentAdvert: () => selfAdvert,
    });
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
          .find((entry) => entry.deviceId === peerIdA)?.advert["agent/self"];
        return (
          typeof advert === "object" &&
          advert !== null &&
          "name" in advert &&
          advert.name === "agent-a"
        );
      }, "B observes A's advertised agent identity");

      const known = transportB
        .listKnownDevices()
        .find((entry) => entry.deviceId === peerIdA);
      expect(known?.advert["agent/self"]).toEqual(selfAdvert);
    } finally {
      await transportB.shutdown();
      await transportA.shutdown();
    }
  });

  test("a session with no agent-self source configured never advertises the agent/self key", async () => {
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
      expect(known?.advert["agent/self"]).toBeUndefined();
    } finally {
      await transportB.shutdown();
      await transportA.shutdown();
    }
  });
});

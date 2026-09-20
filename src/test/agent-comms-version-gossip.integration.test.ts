/**
 * WireMeshTransport's periodic gossip tick also carries this side's own agent-comms (and, when fronting/bridging cc-peer, cc-peer) package versions under AGENT_COMMS_VERSION_GOSSIP_KEY (agent-comms#198), the write half readvertiseGossip's own header comment documents -- unlike presence/hostedRooms/selfAgentAdvert, this fact is never actually absent, so every tick that runs at all carries it. wire-mesh-core's own "wire-mesh/version" key needs no writing here at all: wire-mesh-core injects it into every self-advert unconditionally since wire-mesh#179, so a peer's listKnownDevices already reflects it for free.
 */

import { test, describe, expect } from "vitest";
import { generateIdentity } from "../core/identity.js";
import { toIdentityPort } from "../core/wire-mesh-identity.js";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { WireMeshTransport } from "../core/wire-mesh-transport.js";
import type { AgentSelfAdvert } from "../core/gossip-extensions.js";
import type { TransportEvents } from "../core/transport.js";
import { getOwnPackageVersion } from "../core/package-version.js";
import { getWireMeshCoreVersion } from "../core/wire-mesh-core-version.js";
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
    onDeviceReachable: () => undefined,
  };
}

const selfAdvert: AgentSelfAdvert = {
  name: "agent-a",
  harness: "pi",
  cwd: "/tmp/a",
  pid: 4242,
  startedAt: "2026-01-01T00:00:00.000Z",
  tags: [],
  subscribedRooms: [],
};

describe("WireMeshTransport agent-comms version gossip", () => {
  test("a peer's listKnownDevices reflects another device's advertised agent-comms and wire-mesh-core versions", async () => {
    const identityA = generateIdentity();
    const identityB = generateIdentity();
    const peerIdA = deviceIdToHex(
      await toIdentityPort(identityA).then((p) => p.deviceId),
    );
    const peerIdB = deviceIdToHex(
      await toIdentityPort(identityB).then((p) => p.deviceId),
    );

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
          .find((entry) => entry.deviceId === peerIdA)?.advert[
          "agent-comms/version"
        ];
        return (
          typeof advert === "object" &&
          advert !== null &&
          "agentComms" in advert
        );
      }, "B observes A's advertised agent-comms version");

      const known = transportB
        .listKnownDevices()
        .find((entry) => entry.deviceId === peerIdA);
      expect(known?.advert["agent-comms/version"]).toEqual({
        agentComms: getOwnPackageVersion(),
      });
      expect(known?.advert["wire-mesh/version"]).toBe(getWireMeshCoreVersion());
    } finally {
      await transportB.shutdown();
      await transportA.shutdown();
    }
  });

  test("folds this side's own cc-peer version into the same advert once getCcPeerVersion is wired", async () => {
    const identityA = generateIdentity();
    const identityB = generateIdentity();
    const peerIdA = deviceIdToHex(
      await toIdentityPort(identityA).then((p) => p.deviceId),
    );
    const peerIdB = deviceIdToHex(
      await toIdentityPort(identityB).then((p) => p.deviceId),
    );

    const transportA = new WireMeshTransport(inertEvents(), identityA, {
      presenceReadvertiseIntervalMs: SHORT_INTERVAL_MS,
      getSelfAgentAdvert: () => selfAdvert,
    });
    transportA.getCcPeerVersion = () => "9.9.9";
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
          .find((entry) => entry.deviceId === peerIdA)?.advert[
          "agent-comms/version"
        ];
        return (
          typeof advert === "object" &&
          advert !== null &&
          "ccPeer" in advert &&
          advert.ccPeer === "9.9.9"
        );
      }, "B observes A's advertised cc-peer version");
    } finally {
      await transportB.shutdown();
      await transportA.shutdown();
    }
  });
});

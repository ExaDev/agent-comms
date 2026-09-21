/**
 * Real end-to-end coverage for agent-comms#199's mesh_graph/mesh_trace, against two genuine WireMeshTransport instances joined by a real connectToPeer session -- the same pattern wire-mesh-transport.test.ts's own "WireMeshTransport connectToPeer" describe block already uses, chosen for the identical reason: this needs the transport's own gossip/topology-self-advertisement and path.trace request/response to actually cross the wire, not a mocked session layer.
 */

import { test, describe, expect } from "vitest";
import { generateIdentity } from "../core/identity.js";
import { toIdentityPort } from "../core/wire-mesh-identity.js";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { MeshStore } from "../core/mesh-store.js";
import { WireMeshTransport } from "../core/wire-mesh-transport.js";
import type { TransportEvents } from "../core/transport.js";
import { waitFor, wireTestTransportWithHub } from "./test-transport.js";
import { realHubOverWs, waitForCondition } from "./hub-helpers.js";

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

async function peerId(identity: { deviceId: Uint8Array }): Promise<string> {
  return deviceIdToHex(Uint8Array.from(identity.deviceId));
}

/** A device-id is SHA-256(public key) -- 32 raw bytes, 64 hex characters. */
const DEVICE_ID_BYTE_LENGTH = 32;

describe("WireMeshTransport meshGraph/meshTrace (agent-comms#199)", () => {
  test("meshGraph reports the other side's own self-advertised direct edge once gossip has propagated", async () => {
    const identityA = generateIdentity();
    const identityB = generateIdentity();
    const idA = await peerId(await toIdentityPort(identityA));
    const idB = await peerId(await toIdentityPort(identityB));

    const transportA = new WireMeshTransport(noopEvents(), identityA);
    const transportB = new WireMeshTransport(noopEvents(), identityB);
    try {
      await transportA.startDataServer();
      await transportB.connectToPeer(
        {
          id: idA,
          port: transportA.dataPort,
          startedAt: new Date().toISOString(),
        },
        idB,
      );

      await waitFor(
        () => transportA.meshGraph().nodes.includes(idB),
        "A learns B's own device-id via gossip",
      );
      await waitFor(
        () => transportB.meshGraph().nodes.includes(idA),
        "B learns A's own device-id via gossip",
      );

      // A's own knownDevices holds B's self-advert (never A's own), and B's own topology/peers self-report says its direct peer is A -- the connection each side authenticated over TLS.
      const graphFromA = transportA.meshGraph();
      expect(graphFromA.nodes).toContain(idB);
      expect(graphFromA.edges).toContainEqual({
        kind: "direct",
        from: idB,
        to: idA,
      });

      const graphFromB = transportB.meshGraph();
      expect(graphFromB.nodes).toContain(idA);
      expect(graphFromB.edges).toContainEqual({
        kind: "direct",
        from: idA,
        to: idB,
      });
    } finally {
      await transportB.shutdown();
      await transportA.shutdown();
    }
  });

  test("meshTrace sends a real path.trace over the direct peer session and reports a real RTT", async () => {
    const identityA = generateIdentity();
    const identityB = generateIdentity();
    const idA = await peerId(await toIdentityPort(identityA));
    const idB = await peerId(await toIdentityPort(identityB));

    const transportA = new WireMeshTransport(noopEvents(), identityA);
    const transportB = new WireMeshTransport(noopEvents(), identityB);
    try {
      await transportA.startDataServer();
      await transportB.connectToPeer(
        {
          id: idA,
          port: transportA.dataPort,
          startedAt: new Date().toISOString(),
        },
        idB,
      );

      const result = await transportB.meshTrace(idA);

      expect(result.outcome.result, JSON.stringify(result)).toBe("ok");
      expect(result.rttMs).toBeGreaterThanOrEqual(0);
      expect(result.local.relayed).toBe(false);
      expect(result.remote?.relayed).toBe(false);
    } finally {
      await transportB.shutdown();
      await transportA.shutdown();
    }
  });

  test("meshTrace resolves a not_connected outcome for a device with no known path", async () => {
    const identityA = generateIdentity();
    const transportA = new WireMeshTransport(noopEvents(), identityA);
    const unknownDeviceHex = "ab".repeat(DEVICE_ID_BYTE_LENGTH);
    try {
      const result = await transportA.meshTrace(unknownDeviceHex);
      expect(result.outcome).toEqual({
        result: "error",
        code: "not_connected",
      });
    } finally {
      await transportA.shutdown();
    }
  });

  test("meshGraph reports no nodes before any gossip has been received", async () => {
    const identityA = generateIdentity();
    const transportA = new WireMeshTransport(noopEvents(), identityA);
    try {
      expect(transportA.meshGraph()).toEqual({ nodes: [], edges: [] });
    } finally {
      await transportA.shutdown();
    }
  });

  test("meshTrace routes via the hub's own relay pairing when no direct peer session exists, reporting relayed on both sides", async () => {
    const hub = await realHubOverWs();
    try {
      const storeA = new MeshStore();
      const { transport: transportA } = await wireTestTransportWithHub(storeA);
      const storeB = new MeshStore();
      const { transport: transportB } = await wireTestTransportWithHub(storeB);
      try {
        // A relay-connect naming a device the hub has not yet registered is dropped silently, and registration follows the hub verifying that device's gossiped advert, so being connected is not enough to trace to a peer. Mutual gateway trust lets each side's own hub directory surface the other, and A seeing B there means the hub registered B.
        storeA.gatewayTrust.add(storeB.peerId);
        storeB.gatewayTrust.add(storeA.peerId);
        await transportA.hub.connect(hub.url);
        await transportB.hub.connect(hub.url);
        await waitForCondition(
          () =>
            transportA.hub.peers().includes(storeB.peerId) &&
            transportB.hub.peers().includes(storeA.peerId),
        );

        const result = await transportA.meshTrace(storeB.peerId);

        expect(result.outcome.result, JSON.stringify(result)).toBe("ok");
        expect(result.local.relayed).toBe(true);
        expect(result.local.hubAddress).toBe(hub.url);
        expect(result.remote?.relayed).toBe(true);
      } finally {
        await storeA.shutdown();
        await storeB.shutdown();
      }
    } finally {
      await hub.close();
    }
  });
});

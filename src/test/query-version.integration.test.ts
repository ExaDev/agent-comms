/**
 * WireMeshTransport.queryVersion (agent-comms#198's own cache-bust action): asks a specific device for its own, currently-running wire-mesh-core version live, right now, rather than trusting whatever it last gossiped. Rides sendRoomRequest's own routing against wire-mesh-core's deliberately-ungated core/version domain (spec/version.cddl).
 */

import { test, describe, expect } from "vitest";
import { generateIdentity } from "../core/identity.js";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { WireMeshTransport } from "../core/wire-mesh-transport.js";
import type { TransportEvents } from "../core/transport.js";
import { getWireMeshCoreVersion } from "../core/wire-mesh-core-version.js";

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

describe("WireMeshTransport.queryVersion", () => {
  test("asks a directly-connected peer for its own live wire-mesh-core version", async () => {
    const identityA = generateIdentity();
    const identityB = generateIdentity();
    const idA = await peerId(identityA);
    const idB = await peerId(identityB);

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

      const outcome = await transportB.queryVersion(idA);

      expect(outcome).toEqual({
        result: "ok",
        version: getWireMeshCoreVersion(),
      });
    } finally {
      await transportB.shutdown();
      await transportA.shutdown();
    }
  });

  test("answers no_route for a device with no live session and no gateway trust", async () => {
    const identity = generateIdentity();
    const transport = new WireMeshTransport(noopEvents(), identity);
    try {
      const outcome = await transport.queryVersion("nobody-home");
      // no_route, not unauthorized: nothing was sent anywhere, so there is nobody to have refused it.
      expect(outcome).toEqual({ result: "error", code: "no_route" });
    } finally {
      await transport.shutdown();
    }
  });
});

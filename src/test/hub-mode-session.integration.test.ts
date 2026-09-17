// Integration: two real agent-comms WireMeshTransports discovering each other and exchanging messages through a real wire-mesh relay hub (createRelayHub -- the same domain logic the production mesh.exadev.io Durable Object runs) served over local WebSockets. This is agent-comms#151's own acceptance shape: the hub connection is a relay, not a coordinator -- no connect_request/introduce approval applies, peers discover each other via the hub's gossip forwarding + catch-up, and messages ride relay pairings (sendManageRequest's own targetDevice routing).

import { afterEach, describe, expect, it } from "vitest";
import { realHubOverWs, waitForCondition } from "./hub-helpers.js";
import { generateIdentity } from "../core/identity.js";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { WireMeshTransport } from "../core/wire-mesh-transport.js";
import type { TransportEvents } from "../core/transport.js";

function recordingEvents(): TransportEvents & {
  messages: { from: string; text: string }[];
} {
  const messages: { from: string; text: string }[] = [];
  return {
    messages,
    onMessage: (handle, message) => {
      if (message.method === "peer_joined") {
        messages.push({ from: handle.id, text: message.peer.id });
      }
    },
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

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanups.splice(0)) {
    await close();
  }
});

describe("connectToHub", () => {
  it("two transports discover each other via the hub's gossip and exchange messages through relay pairings", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);

    const eventsA = recordingEvents();
    const eventsB = recordingEvents();
    const transportA = new WireMeshTransport(eventsA, generateIdentity());
    const transportB = new WireMeshTransport(eventsB, generateIdentity());
    await transportA.hub.connect(hub.url);
    await transportB.hub.connect(hub.url);

    // Discovery: each side's hubPeers should eventually list the other.
    const deviceA = await transportA.hub.ownDeviceHex();
    const deviceB = await transportB.hub.ownDeviceHex();
    await waitForCondition(() => {
      return (
        transportA.hub.peers().includes(deviceB) &&
        transportB.hub.peers().includes(deviceA)
      );
    });

    // Messaging: A sends to B via the hub; B's onMessage fires with A's device.
    await transportA.hub.sendToPeer(deviceB, {
      method: "peer_joined",
      peer: {
        id: "hub-says-hi",
        port: 0,
        startedAt: "2026-01-01T00:00:00.000Z",
      },
    });

    await waitForCondition(() => eventsB.messages.length > 0);
    expect(eventsB.messages[0]?.text).toBe("hub-says-hi");
    expect(eventsB.messages[0]?.from).toBe(deviceA);

    await transportA.shutdown();
    await transportB.shutdown();
  });
});

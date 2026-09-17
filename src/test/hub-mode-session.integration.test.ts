// Integration: two real agent-comms WireMeshTransports discovering each other and exchanging messages through a real wire-mesh relay hub (createRelayHub -- the same domain logic the production mesh.exadev.io Durable Object runs) served over local WebSockets. This is agent-comms#151's own acceptance shape: the hub connection is a relay, not a coordinator -- no connect_request/introduce approval applies, peers discover each other via the hub's gossip forwarding + catch-up, and messages ride relay pairings (sendManageRequest's own targetDevice routing).

import { afterEach, describe, expect, it } from "vitest";
import { realHubOverWs, waitForCondition } from "./hub-helpers.js";
import { generateIdentity } from "../core/identity.js";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { WireMeshTransport } from "../core/wire-mesh-transport.js";
import type { ConnectionHandle, TransportEvents } from "../core/transport.js";
import type { MeshMessage } from "../core/wire-protocol.js";

function recordingEvents(): TransportEvents & {
  messages: { from: string; text: string }[];
  allMessages: MeshMessage[];
} {
  const messages: { from: string; text: string }[] = [];
  const allMessages: MeshMessage[] = [];
  return {
    messages,
    allMessages,
    onMessage: (handle: Readonly<ConnectionHandle>, message: MeshMessage) => {
      allMessages.push(message);
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

  it("never applies a state_sync or state_update relayed by an unauthenticated hub peer (agent-comms#169 security finding: real per-peer admission lands in #156, but nothing today should let any hub peer patch local mesh state)", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);

    const eventsA = recordingEvents();
    const eventsB = recordingEvents();
    const transportA = new WireMeshTransport(eventsA, generateIdentity());
    const transportB = new WireMeshTransport(eventsB, generateIdentity());
    await transportA.hub.connect(hub.url);
    await transportB.hub.connect(hub.url);

    const deviceA = await transportA.hub.ownDeviceHex();
    const deviceB = await transportB.hub.ownDeviceHex();
    await waitForCondition(() => {
      return (
        transportA.hub.peers().includes(deviceB) &&
        transportB.hub.peers().includes(deviceA)
      );
    });

    await transportA.hub.sendToPeer(deviceB, {
      method: "state_update",
      patch: { type: "agent_offline", agentId: "spoofed" },
    });
    await transportA.hub.sendToPeer(deviceB, {
      method: "state_sync",
      state: {
        agents: {},
        rooms: {},
        messages: {},
        dms: {},
        deliveryQueues: {},
      },
    });
    // A message type this codebase's own onMessage handler treats as inert either way -- proves the hub connection and relay pairing genuinely delivered something to B (ruling out "nothing arrived at all" as a false-negative explanation for state_update/state_sync never showing up below), while confirming filtering is specific to the two state-mutating methods rather than a blanket drop of everything.
    await transportA.hub.sendToPeer(deviceB, {
      method: "peer_joined",
      peer: {
        id: "proof-of-delivery",
        port: 0,
        startedAt: "2026-01-01T00:00:00.000Z",
      },
    });

    await waitForCondition(() => eventsB.messages.length > 0);
    expect(
      eventsB.allMessages.some(
        (m) => m.method === "state_update" || m.method === "state_sync",
      ),
    ).toBe(false);

    await transportA.shutdown();
    await transportB.shutdown();
  });
});

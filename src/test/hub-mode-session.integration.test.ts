// Integration: two real agent-comms WireMeshTransports discovering each other through a real wire-mesh relay hub (createRelayHub -- the same domain logic the production mesh.exadev.io Durable Object runs) served over local WebSockets. This is agent-comms#151's own acceptance shape: the hub connection is a relay, not a coordinator -- no connect_request/introduce approval applies, peers discover each other via the hub's gossip forwarding + catch-up, and messages ride relay pairings (sendManageRequest's own targetDevice routing). Every transport here is constructed with an explicit GatewayTrust mutually trusting the other side's device-id (agent-comms#156's own deny-by-default trust boundary): without it, hub-session.ts's own directory-merge and consume() gates would drop the other side's gossip/messages entirely before any of this file's own assertions could run.

import { afterEach, describe, expect, it } from "vitest";
import { acceptMeshSession } from "wire-mesh-core/domain/mesh-session";
import {
  realHubOverWs,
  TeardownStack,
  waitForCondition,
} from "./hub-helpers.js";
import { generateIdentity } from "../core/identity.js";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import {
  buildCommand,
  DOMAIN,
  FRAME_SCOPE,
  WireMeshTransport,
} from "../core/wire-mesh-transport.js";
import { toIdentityPort } from "../core/wire-mesh-identity.js";
import { connectWsUrl } from "../core/ws-dial.js";
import { GatewayTrust } from "../core/gateway-trust.js";
import type { ConnectionHandle, TransportEvents } from "../core/transport.js";
import type { MeshMessage } from "../core/wire-protocol.js";

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

const cleanups = new TeardownStack();

afterEach(async () => {
  await cleanups.run();
});

describe("connectToHub", () => {
  it("two transports discover each other through the hub's gossip", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);

    const eventsA = noopEvents();
    const eventsB = noopEvents();
    const identityA = generateIdentity();
    const identityB = generateIdentity();
    const deviceA = deviceIdToHex(Uint8Array.from(identityA.deviceId));
    const deviceB = deviceIdToHex(Uint8Array.from(identityB.deviceId));
    // Gateway trust (agent-comms#156) is deny-all by default: each side's own hub-session directory-merge and consume() gates would otherwise drop the other's gossip/messages entirely, so hub.peers() would never populate and onMessage would never fire. Mutual trust here for both.
    const gatewayTrustA = new GatewayTrust();
    gatewayTrustA.add(deviceB);
    const gatewayTrustB = new GatewayTrust();
    gatewayTrustB.add(deviceA);
    const transportA = new WireMeshTransport(eventsA, identityA, {
      gatewayTrust: gatewayTrustA,
    });
    const transportB = new WireMeshTransport(eventsB, identityB, {
      gatewayTrust: gatewayTrustB,
    });
    await transportA.hub.connect(hub.url);
    await transportB.hub.connect(hub.url);

    // Discovery: each side's hubPeers should eventually list the other.
    await waitForCondition(() => {
      return (
        transportA.hub.peers().includes(deviceB) &&
        transportB.hub.peers().includes(deviceA)
      );
    });

    await transportA.shutdown();
    await transportB.shutdown();
  });

  it("discovers a peer via gossip when that peer is trusted only as a principal, not as a bare device (agent-comms#192's own directory-merge widening)", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);

    const eventsA = noopEvents();
    const eventsB = noopEvents();
    const identityA = generateIdentity();
    const identityB = generateIdentity();
    const deviceA = deviceIdToHex(Uint8Array.from(identityA.deviceId));
    const deviceB = deviceIdToHex(Uint8Array.from(identityB.deviceId));
    // B trusts A's device as a PRINCIPAL (addPrincipal), never on the bare-device allowlist (add) -- proving connect()'s own directory-merge filter now accepts isTrustedForDirectory (bare-device OR principal), not only the original bare-device isTrusted. A trusts nothing at all: whether B's own gossip surfaces here has nothing to do with what A trusts, only with what B's own incoming filter accepts.
    const gatewayTrustA = new GatewayTrust();
    const gatewayTrustB = new GatewayTrust();
    gatewayTrustB.addPrincipal(deviceA);
    const transportA = new WireMeshTransport(eventsA, identityA, {
      gatewayTrust: gatewayTrustA,
    });
    const transportB = new WireMeshTransport(eventsB, identityB, {
      gatewayTrust: gatewayTrustB,
    });
    await transportA.hub.connect(hub.url);
    await transportB.hub.connect(hub.url);

    await waitForCondition(() => transportB.hub.peers().includes(deviceA));
    // The bare-device allowlist is untouched by this widening: A was never added() to gatewayTrustB, only addPrincipal()'d, so isTrusted(deviceA) itself must still read false even though isTrustedForDirectory let the gossip through.
    expect(gatewayTrustB.isTrusted(deviceA)).toBe(false);

    await transportA.shutdown();
    await transportB.shutdown();
  });

  it("answers a raw legacy frame relayed by a trusted hub peer with unsupported_verb and never applies its state_sync or state_update (agent-comms#169, agent-comms#268)", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);

    const received: MeshMessage[] = [];
    const eventsB: TransportEvents = {
      ...noopEvents(),
      onMessage: (
        _handle: Readonly<ConnectionHandle>,
        message: MeshMessage,
      ) => {
        received.push(message);
      },
    };
    const attackerIdentity = generateIdentity();
    const identityB = generateIdentity();
    const attackerHex = deviceIdToHex(
      Uint8Array.from(attackerIdentity.deviceId),
    );
    // B trusts the sender outright, so the only thing standing between the frame and B's mesh state is the relay path's own refusal of the frame verb, not the gateway trust gate.
    const gatewayTrustB = new GatewayTrust();
    gatewayTrustB.add(attackerHex);
    const transportB = new WireMeshTransport(eventsB, identityB, {
      gatewayTrust: gatewayTrustB,
    });
    await transportB.hub.connect(hub.url);

    const attacker = await acceptMeshSession(
      await connectWsUrl(hub.url),
      await toIdentityPort(attackerIdentity),
      [DOMAIN],
      { onFrame: async () => undefined, addresses: [] },
    );
    cleanups.push(async () => attacker.close());
    const target = Uint8Array.from(identityB.deviceId);

    await waitForCondition(() => transportB.hub.peers().includes(attackerHex));

    const stateUpdate = await attacker.sendManageRequest(
      buildCommand({
        method: "state_update",
        patch: { type: "agent_offline", agentId: "spoofed" },
      }),
      FRAME_SCOPE,
      target,
    );
    const stateSync = await attacker.sendManageRequest(
      buildCommand({
        method: "state_sync",
        state: {
          agents: {},
          rooms: {},
          messages: {},
          dms: {},
          deliveryQueues: {},
        },
      }),
      FRAME_SCOPE,
      target,
    );
    // An ordinary message type is refused the same way: the relay path accepts no frame at all, not merely the two that mutate state.
    const peerJoined = await attacker.sendManageRequest(
      buildCommand({
        method: "peer_joined",
        peer: { id: "x", port: 0, startedAt: "2026-01-01T00:00:00.000Z" },
      }),
      FRAME_SCOPE,
      target,
    );

    expect(stateUpdate).toEqual({ result: "error", code: "unsupported_verb" });
    expect(stateSync).toEqual({ result: "error", code: "unsupported_verb" });
    expect(peerJoined).toEqual({ result: "error", code: "unsupported_verb" });
    expect(received).toEqual([]);

    await transportB.shutdown();
  });

  it("reports the answering side's own dialled hub address on a hub-relayed path.trace (agent-comms#216)", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);

    const eventsA = noopEvents();
    const eventsB = noopEvents();
    const identityA = generateIdentity();
    const identityB = generateIdentity();
    const deviceA = deviceIdToHex(Uint8Array.from(identityA.deviceId));
    const deviceB = deviceIdToHex(Uint8Array.from(identityB.deviceId));
    const gatewayTrustA = new GatewayTrust();
    gatewayTrustA.add(deviceB);
    const gatewayTrustB = new GatewayTrust();
    gatewayTrustB.add(deviceA);
    const transportA = new WireMeshTransport(eventsA, identityA, {
      gatewayTrust: gatewayTrustA,
    });
    const transportB = new WireMeshTransport(eventsB, identityB, {
      gatewayTrust: gatewayTrustB,
    });
    await transportA.hub.connect(hub.url);
    await transportB.hub.connect(hub.url);

    await waitForCondition(() => {
      return (
        transportA.hub.peers().includes(deviceB) &&
        transportB.hub.peers().includes(deviceA)
      );
    });

    // A and B are only gossip-discovered through the hub here (never directly connected), so meshTrace's own direct-session lookup misses and it falls to the hub-relayed path -- exactly the case agent-comms#216 fixes: B answers over the same session it dialled the hub with, and should now report that dialled address back as remote.hubAddress.
    const result = await transportA.meshTrace(deviceB);

    expect(result.outcome.result).toBe("ok");
    expect(result.remote?.relayed).toBe(true);
    expect(result.remote?.hubAddress).toBe(hub.url);

    await transportA.shutdown();
    await transportB.shutdown();
  });
});

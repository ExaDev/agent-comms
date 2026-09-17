/**
 * WireMeshTransport.sendRoomRequest's own gateway-trust gate (agent-comms#156) -- split out of wire-mesh-transport.test.ts to stay under this repo's max-lines cap, the same reason wire-mesh-transport-hub.test.ts and wire-mesh-transport-shutdown-unref.test.ts were split.
 */
import { test, describe, expect } from "vitest";
import { generateIdentity } from "../core/identity.js";
import { WireMeshTransport } from "../core/wire-mesh-transport.js";
import { GatewayTrust } from "../core/gateway-trust.js";
import type { TransportEvents } from "../core/transport.js";

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
  };
}

describe("WireMeshTransport.sendRoomRequest -- gateway trust", () => {
  test("resolves unauthorized without ever touching the hub when the target device isn't trusted", async () => {
    const identity = generateIdentity();
    // No GatewayTrust passed -- defaults to a fresh, empty (deny-all) instance.
    const transport = new WireMeshTransport(noopEvents(), identity);
    try {
      const outcome = await transport.sendRoomRequest(
        "nobody-home",
        { verb: "room.send", params: {} },
        { kind: "agent-comms-mesh" },
      );
      expect(outcome).toEqual({ result: "error", code: "unauthorized" });
    } finally {
      await transport.shutdown();
    }
  });

  test("falls through to the ordinary not_connected outcome once the target device is trusted", async () => {
    const identity = generateIdentity();
    const gatewayTrust = new GatewayTrust();
    gatewayTrust.add("nobody-home");
    const transport = new WireMeshTransport(
      noopEvents(),
      identity,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      gatewayTrust,
    );
    try {
      const outcome = await transport.sendRoomRequest(
        "nobody-home",
        { verb: "room.send", params: {} },
        { kind: "agent-comms-mesh" },
      );
      // Trusted, but there is no live local session and this transport was never dialled into a hub -- routeRoomRequestViaHub's own not_connected outcome, unaffected by the trust gate once it's passed.
      expect(outcome).toEqual({ result: "error", code: "not_connected" });
    } finally {
      await transport.shutdown();
    }
  });
});

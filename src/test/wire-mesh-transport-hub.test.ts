/**
 * WireMeshTransport connectHub/disconnectHub (agent-comms#154) -- split out of wire-mesh-transport.test.ts to stay under this repo's max-lines cap, the same reason wire-mesh-transport-shutdown-unref.test.ts was split. Uses the real relay-hub-over-ws harness (hub-helpers.ts) rather than a mocked HubSession, since the behaviour under test is specifically that connectHub/disconnectHub reach the real HubSession instance the transport constructs for itself.
 */

import { test, describe, expect } from "vitest";
import { generateIdentity } from "../core/identity.js";
import { WireMeshTransport } from "../core/wire-mesh-transport.js";
import type { TransportEvents } from "../core/transport.js";
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
  };
}

describe("WireMeshTransport connectHub/disconnectHub", () => {
  test("connectHub dials the given hub URL and disconnectHub drops it, observable on the hub's own connection count", async () => {
    const hub = await realHubOverWs();
    const transport = new WireMeshTransport(noopEvents(), generateIdentity());
    try {
      expect(transport.hub.isConnected).toBe(false);

      await transport.connectHub?.(hub.url);

      expect(transport.hub.isConnected).toBe(true);
      await waitForCondition(() => hub.connectionCount() === 1);

      await transport.disconnectHub?.();

      expect(transport.hub.isConnected).toBe(false);
      await waitForCondition(() => hub.connectionCount() === 0);
    } finally {
      await transport.shutdown();
      await hub.close();
    }
  });

  test("disconnectHub is a safe no-op when connectHub was never called", async () => {
    const transport = new WireMeshTransport(noopEvents(), generateIdentity());
    try {
      await expect(transport.disconnectHub?.()).resolves.toBeUndefined();
    } finally {
      await transport.shutdown();
    }
  });
});

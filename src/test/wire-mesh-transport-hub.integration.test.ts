/**
 * WireMeshTransport joinHub (agent-comms#154, per store since agent-comms#293) -- split out of wire-mesh-transport.test.ts to stay under this repo's max-lines cap, the same reason wire-mesh-transport-shutdown-unref.test.ts was split. Uses the real relay-hub-over-ws harness (hub-helpers.ts) rather than a mocked HubSession, since the behaviour under test is specifically that joinHub drives the real HubSession instance the transport constructs for itself.
 */

import { test, describe, expect } from "vitest";
import { generateIdentity } from "../core/identity.js";
import { GatewayTrust } from "../core/gateway-trust.js";
import { WireMeshTransport } from "../core/wire-mesh-transport.js";
import type { TransportEvents } from "../core/transport.js";
import {
  realHubOverWs,
  unreachableHubUrl,
  waitForCondition,
} from "./hub-helpers.js";

/** A device-id is a 64-character lowercase hex SHA-256 digest. */
const DEVICE_ID_HEX_LENGTH = 64;

/** Long enough for HubLink's first redial delay plus a real reconnect, but short of the test timeout. */
const HUB_RETURN_TIMEOUT_MS = 10_000;

/** Gossip tick short enough for several to land inside GOSSIP_WATCH_MS. */
const GOSSIP_TICK_MS = 50;

/** How long gossip is watched after the last redial for a send to a dead session. */
const GOSSIP_WATCH_MS = 500;

/** Hub outages the transport must ride out before the watch. */
const HUB_BOUNCES = 2;

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

describe("WireMeshTransport joinHub", () => {
  test("joinHub dials the hub in the background and shutdown drops the session, observable on the hub's own connection count", async () => {
    const hub = await realHubOverWs();
    const transport = new WireMeshTransport(noopEvents(), generateIdentity());
    try {
      expect(transport.hub.isConnected).toBe(false);

      transport.joinHub(hub.url, () => true);

      await waitForCondition(() => transport.hub.isConnected);
      await waitForCondition(() => hub.connectionCount() === 1);

      await transport.shutdown();

      expect(transport.hub.isConnected).toBe(false);
      await waitForCondition(() => hub.connectionCount() === 0);
    } finally {
      await transport.shutdown();
      await hub.close();
    }
  });

  test("joinHub returns before the hub has answered, and an unreachable hub is reported without throwing", async () => {
    const errors: Error[] = [];
    const transport = new WireMeshTransport(
      {
        ...noopEvents(),
        onError: (error) => {
          errors.push(error);
        },
      },
      generateIdentity(),
    );
    try {
      transport.joinHub(await unreachableHubUrl(), () => true);

      expect(transport.hub.isConnected).toBe(false);
      await waitForCondition(() => errors.length > 0);
      expect(transport.hub.isConnected).toBe(false);
    } finally {
      await transport.shutdown();
    }
  });

  test("joinHub dials again once a hub that went away comes back on the same address", async () => {
    const first = await realHubOverWs();
    const transport = new WireMeshTransport(noopEvents(), generateIdentity());
    let second: Awaited<ReturnType<typeof realHubOverWs>> | undefined;
    try {
      transport.joinHub(first.url, () => true);
      await waitForCondition(() => transport.hub.isConnected);

      await first.close();
      await waitForCondition(() => !transport.hub.isConnected);

      second = await realHubOverWs({ port: first.port });
      await waitForCondition(
        () => transport.hub.isConnected,
        HUB_RETURN_TIMEOUT_MS,
      );
      await waitForCondition(() => second?.connectionCount() === 1);
    } finally {
      await transport.shutdown();
      await second?.close();
    }
  });

  test("a session the hub ended is forgotten, so gossip after a redial reaches only the live session", async () => {
    const errors: Error[] = [];
    const trust = new GatewayTrust();
    trust.add("f".repeat(DEVICE_ID_HEX_LENGTH));
    const transport = new WireMeshTransport(
      {
        ...noopEvents(),
        onError: (error) => {
          errors.push(error);
        },
      },
      generateIdentity(),
      {
        gatewayTrust: trust,
        getCurrentPresence: () => "active",
        getSelfAgentAdvert: () => ({
          name: "gossip-after-redial",
          harness: "test",
          cwd: "/test",
          pid: process.pid,
          startedAt: "2026-01-01T00:00:00.000Z",
          tags: [],
          subscribedRooms: [],
        }),
        presenceReadvertiseIntervalMs: GOSSIP_TICK_MS,
      },
    );
    let hub = await realHubOverWs();
    const { port } = hub;
    try {
      transport.joinHub(hub.url, () => true);
      await waitForCondition(() => transport.hub.isConnected);

      for (let bounce = 0; bounce < HUB_BOUNCES; bounce += 1) {
        await hub.close();
        await waitForCondition(() => !transport.hub.isConnected);
        hub = await realHubOverWs({ port });
        await waitForCondition(
          () => transport.hub.isConnected,
          HUB_RETURN_TIMEOUT_MS,
        );
      }
      const errorsBeforeWatch = errors.length;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, GOSSIP_WATCH_MS);
      });

      expect(errors.slice(errorsBeforeWatch)).toEqual([]);
    } finally {
      await transport.shutdown();
      await hub.close();
    }
  });

  test("shutdown is safe when joinHub was never called", async () => {
    const transport = new WireMeshTransport(noopEvents(), generateIdentity());
    await expect(transport.shutdown()).resolves.toBeUndefined();
  });
});

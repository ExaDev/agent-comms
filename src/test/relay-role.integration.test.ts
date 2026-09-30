/**
 * The relay role over real sockets (agent-comms#342): the store holding a machine's elected coordinator role serves a relay while it holds an uplink to the configured hub, offers it over gossip, and the machine's other stores hold their hub session over it instead of the public hub.
 */

import { expect, test } from "vitest";
import { MeshStore } from "../core/mesh-store.js";
import type { WireMeshTransport } from "../core/wire-mesh-transport.js";
import { TeardownStack, freeLocalPort, realHubOverWs } from "./hub-helpers.js";
import { waitFor, wireTestTransportWithHub } from "./test-transport.js";

/** A remote device to trust, so each store has something to say to another machine and wants a hub session. */
/** A device-id is a hex-encoded SHA-256 digest: 32 bytes, 64 hex characters. */
const DEVICE_ID_HEX_LENGTH = 64;
const REMOTE_DEVICE_HEX = "f".repeat(DEVICE_ID_HEX_LENGTH);

/** Short enough that a gossip re-advertisement fires within a test's poll budget, unlike the production default. */
const FAST_GOSSIP_INTERVAL_MS = 50;

interface Node {
  store: MeshStore;
  transport: WireMeshTransport;
}

async function startNode(
  name: string,
  options: Readonly<{ coordinatorPort: number; hubUrl: string }>,
  teardown: TeardownStack,
): Promise<Node> {
  const store = new MeshStore(options);
  const { transport } = await wireTestTransportWithHub(store, {
    presenceReadvertiseIntervalMs: FAST_GOSSIP_INTERVAL_MS,
  });
  teardown.push(async () => {
    await store.shutdown().catch(() => undefined);
  });
  await store.init();
  await store.registerAgent({
    name,
    harness: "test",
    cwd: `/test/${name}`,
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  return { store, transport };
}

test("the machine's elected coordinator serves a relay once it holds an uplink, and the machine's other store holds its hub session over that relay", async () => {
  const teardown = new TeardownStack();
  try {
    const hub = await realHubOverWs();
    teardown.push(hub.close);
    const coordinatorPort = await freeLocalPort();
    const options = { coordinatorPort, hubUrl: hub.url };
    const first = await startNode("first", options, teardown);
    const second = await startNode("second", options, teardown);
    // Something to say to another machine is what makes a store want a hub session at all.
    first.store.addTrustedGateway(REMOTE_DEVICE_HEX);
    second.store.addTrustedGateway(REMOTE_DEVICE_HEX);

    await waitFor(
      () => first.transport.relay.servedConnectionCount() === 1,
      "the second store moved its hub session onto the first store's relay",
    );

    expect(first.store.holdsCoordinatorRole).toBe(true);
    expect(first.transport.relay.offer()).toEqual([
      expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+\/$/),
    ]);
    expect(second.transport.relay.offer()).toBeUndefined();
    expect(second.transport.hub.isConnected).toBe(true);
    await waitFor(
      () => hub.connectionCount() === 1,
      "only the relay's own uplink is left on the public hub",
    );
  } finally {
    await teardown.run();
  }
});

test("a store falls back to the public hub when the relay it used goes away, and serves the relay itself once it holds the coordinator role", async () => {
  const teardown = new TeardownStack();
  try {
    const hub = await realHubOverWs();
    teardown.push(hub.close);
    const coordinatorPort = await freeLocalPort();
    const options = { coordinatorPort, hubUrl: hub.url };
    const first = await startNode("first", options, teardown);
    const second = await startNode("second", options, teardown);
    first.store.addTrustedGateway(REMOTE_DEVICE_HEX);
    second.store.addTrustedGateway(REMOTE_DEVICE_HEX);
    await waitFor(
      () => first.transport.relay.servedConnectionCount() === 1,
      "the second store is on the first store's relay",
    );

    await first.store.shutdown();

    await waitFor(
      () =>
        second.store.holdsCoordinatorRole &&
        second.transport.relay.offer() !== undefined,
      "the survivor took the coordinator role and serves the relay",
    );
    await waitFor(
      () => hub.connectionCount() === 1 && second.transport.hub.isConnected,
      "the survivor holds the uplink to the public hub",
    );
  } finally {
    await teardown.run();
  }
});

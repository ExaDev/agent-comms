/**
 * The relay role over real sockets (agent-comms#342): the store holding a machine's elected coordinator role serves a relay while it holds an uplink to the configured hub, offers it over gossip, and the machine's other stores hold their hub session over it instead of the public hub.
 */

import { expect, test } from "vitest";
import { MeshStore } from "../core/mesh-store.js";
import { dmRoomPath } from "../core/room-path.js";
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
    await waitFor(
      () => second.transport.hub.isConnected,
      "the second store's hub session is up over the relay",
    );
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

test("a store behind the relay and a device on the public hub reach each other through the relay's uplink, each seen under its own device-id", async () => {
  const teardown = new TeardownStack();
  try {
    const hub = await realHubOverWs();
    teardown.push(hub.close);
    const machineA = {
      coordinatorPort: await freeLocalPort(),
      hubUrl: hub.url,
    };
    const machineB = {
      coordinatorPort: await freeLocalPort(),
      hubUrl: hub.url,
    };
    const relayHolder = await startNode("a1", machineA, teardown);
    const behindRelay = await startNode("a2", machineA, teardown);
    const remote = await startNode("b1", machineB, teardown);
    for (const local of [relayHolder, behindRelay]) {
      local.store.addTrustedGateway(remote.store.peerId);
      remote.store.addTrustedGateway(local.store.peerId);
    }
    await waitFor(
      () => relayHolder.transport.relay.servedConnectionCount() === 1,
      "the second store of the machine is a client of the first store's relay",
    );
    await waitFor(
      () => relayHolder.transport.relay.routableClientCount() === 1,
      "the relay can route to the store behind it",
    );
    await waitFor(
      () => hub.connectionCount() === 2,
      "the public hub holds the relay's uplink and the remote device, and not the store behind the relay",
    );

    await waitFor(async () => {
      const agents = await remote.store.listAgents(remote.store.peerId);
      return agents.some((agent) => agent.id === behindRelay.store.peerId);
    }, "the remote device learned of the store behind the relay under its own device-id");
    await waitFor(async () => {
      const agents = await behindRelay.store.listAgents(
        behindRelay.store.peerId,
      );
      return agents.some((agent) => agent.id === remote.store.peerId);
    }, "the store behind the relay learned of the remote device under its own device-id");

    const dmPath = dmRoomPath(behindRelay.store.peerId, remote.store.peerId);
    const request = behindRelay.store.requestDmAccess(remote.store.peerId);
    await waitFor(
      () => remote.store.listPendingRoomJoins().length === 1,
      "the remote device saw the request from the store behind the relay",
    );
    expect(remote.store.listPendingRoomJoins()[0]?.requesterId).toBe(
      behindRelay.store.peerId,
    );
    remote.store.acceptRoomJoin(dmPath, behindRelay.store.peerId);
    await request;

    const outbound = await behindRelay.store.sendDm(
      behindRelay.store.peerId,
      remote.store.peerId,
      "from behind the relay",
    );
    await waitFor(
      () =>
        (remote.store.serialise().dms[dmPath] ?? []).some(
          (message) => message.id === outbound.message.id,
        ),
      "the remote device received the message sent from behind the relay",
    );
    expect(
      (remote.store.serialise().dms[dmPath] ?? []).find(
        (message) => message.id === outbound.message.id,
      ),
    ).toMatchObject({
      from: behindRelay.store.peerId,
      to: remote.store.peerId,
    });

    const inbound = await remote.store.sendDm(
      remote.store.peerId,
      behindRelay.store.peerId,
      "from the public hub",
    );
    await waitFor(
      () =>
        (behindRelay.store.serialise().dms[dmPath] ?? []).some(
          (message) => message.id === inbound.message.id,
        ),
      "the store behind the relay received the message sent from the public hub",
    );
    expect(
      (behindRelay.store.serialise().dms[dmPath] ?? []).find(
        (message) => message.id === inbound.message.id,
      ),
    ).toMatchObject({
      from: remote.store.peerId,
      to: behindRelay.store.peerId,
    });
  } finally {
    await teardown.run();
  }
});

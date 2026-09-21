/**
 * The hub session across a local coordinator handover (agent-comms#293), against a real relay hub. Every store holds its own hub session from init, so losing the coordinator, gracefully or abruptly, must neither cost a surviving store its session nor make another machine lose sight of it. This is the property the coordinator-only gateway lacked: reachability from another machine followed whichever store won the coordinator role.
 */

import { randomInt } from "node:crypto";
import { expect, test } from "vitest";
import { MeshStore } from "../core/mesh-store.js";
import type { WireMeshTransport } from "../core/wire-mesh-transport.js";
import { TeardownStack, realHubOverWs } from "./hub-helpers.js";
import { waitFor, wireTestTransportWithHub } from "./test-transport.js";

/** Start of this file's own reserved port band, clear of the other integration tests' bands. */
const HUB_FAILOVER_PORT_RANGE_START = 21_900;
const HUB_FAILOVER_PORT_RANGE_WIDTH = 300;

/** Short enough that a re-advertised agent reaches the other machine within a test's own wait, unlike the production default. */
const FAST_GOSSIP_INTERVAL_MS = 50;

interface Node {
  store: MeshStore;
  transport: WireMeshTransport;
}

async function startNode(
  name: string,
  coordinatorPort: number,
  hubUrl: string,
  teardown: TeardownStack,
): Promise<Node> {
  const store = new MeshStore({ coordinatorPort, hubUrl });
  const { transport } = await wireTestTransportWithHub(store, {
    presenceReadvertiseIntervalMs: FAST_GOSSIP_INTERVAL_MS,
  });
  await store.init();
  await store.registerAgent({
    name,
    harness: `test-${name}`,
    cwd: `/test/${name}`,
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  teardown.push(async () => {
    await store.shutdown().catch(() => undefined);
  });
  return { store, transport };
}

/** Two stores on one machine (first is the coordinator) and one store on another machine, all on one hub, with the remote store and the survivor trusting each other. */
async function startMachines(teardown: TeardownStack): Promise<{
  first: Node;
  second: Node;
  remote: Node;
}> {
  const hub = await realHubOverWs();
  teardown.push(hub.close);
  const port =
    HUB_FAILOVER_PORT_RANGE_START + randomInt(HUB_FAILOVER_PORT_RANGE_WIDTH);
  const first = await startNode("first", port, hub.url, teardown);
  const second = await startNode("second", port, hub.url, teardown);
  const remote = await startNode(
    "remote",
    port + HUB_FAILOVER_PORT_RANGE_WIDTH,
    hub.url,
    teardown,
  );
  second.store.addTrustedGateway(remote.store.peerId);
  remote.store.addTrustedGateway(second.store.peerId);
  await waitFor(
    () => first.transport.hub.isConnected && second.transport.hub.isConnected,
    "both local stores hold their own hub session",
  );
  await waitFor(
    async () =>
      (await remote.store.listAgents(remote.store.peerId)).some(
        (agent) => agent.id === second.store.peerId,
      ),
    "the remote store sees the second store's agent before the coordinator is lost",
  );
  return { first, second, remote };
}

async function remoteSees(remote: Node, agentId: string): Promise<boolean> {
  const agents = await remote.store.listAgents(remote.store.peerId);
  return agents.some(
    (agent) => agent.id === agentId && agent.status !== "offline",
  );
}

test("a surviving store keeps its own hub session and stays visible to another machine after the coordinator shuts down gracefully", async () => {
  const teardown = new TeardownStack();
  try {
    const { first, second, remote } = await startMachines(teardown);

    await first.store.shutdown();

    await waitFor(
      () => second.transport.isCoordinator,
      "the survivor took the coordinator role",
    );
    expect(second.transport.hub.isConnected).toBe(true);
    await waitFor(
      async () => remoteSees(remote, second.store.peerId),
      "the remote store still sees the survivor's agent",
    );
  } finally {
    await teardown.run();
  }
});

test("a surviving store keeps its own hub session and stays visible to another machine after the coordinator is lost abruptly", async () => {
  const teardown = new TeardownStack();
  try {
    const { first, second, remote } = await startMachines(teardown);

    await first.transport.shutdown();

    await waitFor(
      () => second.transport.isCoordinator,
      "the survivor rebound the vacated coordinator port",
    );
    expect(second.transport.hub.isConnected).toBe(true);
    await waitFor(
      async () => remoteSees(remote, second.store.peerId),
      "the remote store still sees the survivor's agent",
    );
  } finally {
    await teardown.run();
  }
});

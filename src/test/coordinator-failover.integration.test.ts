/**
 * Coordinator failover over real localhost sockets (agent-comms#285): several MeshStore instances, each on its own WireMeshTransport, with the coordinator's transport torn down abruptly (no handover, the way a killed process behaves) and again gracefully. Asserts what a survivor of either kind of loss actually ends up with -- a rebound coordinator port, a mesh a fresh store can still join, and no dead agent left listed as active. The decision logic these exercise is unit-tested against fakes in coordinator-failover.unit.test.ts.
 */

import { randomInt } from "node:crypto";
import { test, expect } from "vitest";
import { MeshStore } from "../core/mesh-store.js";
import type { WireMeshTransport } from "../core/wire-mesh-transport.js";
import type { AgentIdentity } from "../core/types.js";
import { TeardownStack, unreachableHubUrl } from "./hub-helpers.js";
import { waitFor, wireTestTransportWithHub } from "./test-transport.js";

/** Start of this file's own reserved port band -- clear of the fixed literals sibling integration tests hardcode (19878-19897) and of mesh-e2e's own randomised band (20100-20999), so a random pick here can never collide with one of those. */
const FAILOVER_PORT_RANGE_START = 21_100;
/** Width of the reserved band, wide enough that two concurrent runs of this file picking the same port by chance is negligible. */
const FAILOVER_PORT_RANGE_WIDTH = 700;

function freshCoordinatorPort(): number {
  return FAILOVER_PORT_RANGE_START + randomInt(FAILOVER_PORT_RANGE_WIDTH);
}

interface Node {
  name: string;
  store: MeshStore;
  transport: WireMeshTransport;
  agentId: string;
}

/** Starts one real store on its own transport, joining (or creating) the mesh on coordinatorPort. hubUrl names a port with nothing behind it: taking the coordinator role always dials the gateway hub, and these tests are about local coordinator election rather than cross-machine relaying, so the dial is left to fail fast and be swallowed by CoordinatorGateway exactly as it is on a machine with no hub. */
async function startNode(
  name: string,
  coordinatorPort: number,
  teardown: TeardownStack,
): Promise<Node> {
  const store = new MeshStore({
    coordinatorPort,
    hubUrl: await unreachableHubUrl(),
  });
  const { transport } = await wireTestTransportWithHub(store);
  await store.init();
  const agent = await store.registerAgent({
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
  return { name, store, transport, agentId: agent.id };
}

/** The agents each node can see, keyed by agent id, as that node itself would answer list_agents. */
async function agentsOf(node: Node): Promise<Map<string, AgentIdentity>> {
  const agents = await node.store.listAgents(node.agentId);
  return new Map(agents.map((agent) => [agent.id, agent]));
}

function coordinators(nodes: readonly Node[]): Node[] {
  return nodes.filter((node) => node.transport.isCoordinator);
}

/** Tears the coordinator's transport down without ever calling store.shutdown(), which is what makes this a crash rather than a handover: no become_coordinator is sent and no successor is named, exactly as when the process is killed and the operating system closes its sockets. */
async function killWithoutHandover(node: Node): Promise<void> {
  await node.transport.shutdown();
}

test("a survivor takes over the coordinator port after the coordinator is killed", async () => {
  const teardown = new TeardownStack();
  try {
    const port = freshCoordinatorPort();
    const first = await startNode("first", port, teardown);
    const second = await startNode("second", port, teardown);
    await waitFor(
      () => second.transport.hasCoordinatorConnection,
      "second joined the mesh through the coordinator port",
    );
    expect(first.transport.isCoordinator).toBe(true);

    await killWithoutHandover(first);

    await waitFor(
      () => second.transport.isCoordinator,
      "the surviving peer rebound the vacated coordinator port",
    );

    const joiner = await startNode("joiner", port, teardown);
    await waitFor(
      () => joiner.transport.hasCoordinatorConnection,
      "a fresh store joined through the rebound coordinator port",
    );
    await waitFor(
      async () => (await agentsOf(second)).has(joiner.agentId),
      "the new coordinator learned the fresh store's agent",
    );
    await waitFor(
      async () => (await agentsOf(joiner)).has(second.agentId),
      "the fresh store learned the new coordinator's agent",
    );
  } finally {
    await teardown.run();
  }
});

test("a killed coordinator's agent stops being listed as active on every survivor", async () => {
  const teardown = new TeardownStack();
  try {
    const port = freshCoordinatorPort();
    const first = await startNode("first", port, teardown);
    const second = await startNode("second", port, teardown);
    const third = await startNode("third", port, teardown);
    await waitFor(
      async () =>
        (await agentsOf(second)).has(first.agentId) &&
        (await agentsOf(third)).has(first.agentId),
      "both survivors learned the coordinator's agent before it dies",
    );

    await killWithoutHandover(first);

    await waitFor(
      async () =>
        (await agentsOf(second)).get(first.agentId)?.status === "offline",
      "the dead coordinator's agent is offline on the second peer",
    );
    await waitFor(
      async () =>
        (await agentsOf(third)).get(first.agentId)?.status === "offline",
      "the dead coordinator's agent is offline on the third peer",
    );
  } finally {
    await teardown.run();
  }
});

test("exactly one of three peers wins the race for the vacated coordinator port", async () => {
  const teardown = new TeardownStack();
  try {
    const port = freshCoordinatorPort();
    const first = await startNode("first", port, teardown);
    const second = await startNode("second", port, teardown);
    const third = await startNode("third", port, teardown);
    await waitFor(
      () =>
        second.transport.hasCoordinatorConnection &&
        third.transport.hasCoordinatorConnection,
      "both other peers joined through the coordinator port",
    );

    await killWithoutHandover(first);

    const survivors = [second, third];
    await waitFor(
      () => coordinators(survivors).length === 1,
      "one survivor rebound the vacated coordinator port",
    );

    // The loser's own bind attempts run on their own retry schedule, so this holds the "exactly one" claim across the whole window in which a second winner could still have appeared.
    const loser = survivors.find((node) => !node.transport.isCoordinator);
    expect(loser).toBeDefined();
    if (loser === undefined) throw new Error("expected a losing survivor");
    await waitFor(
      () => loser.transport.hasCoordinatorConnection,
      "the losing survivor rejoined under the new coordinator",
    );
    expect(coordinators(survivors)).toHaveLength(1);

    const joiner = await startNode("joiner", port, teardown);
    await waitFor(
      async () => (await agentsOf(joiner)).has(loser.agentId),
      "a fresh joiner is told about the losing survivor too, so it rejoined as a full member",
    );
  } finally {
    await teardown.run();
  }
});

test("a graceful shutdown still hands the coordinator role to the longest-running peer", async () => {
  const teardown = new TeardownStack();
  try {
    const port = freshCoordinatorPort();
    const first = await startNode("first", port, teardown);
    const second = await startNode("second", port, teardown);
    await waitFor(
      () => second.transport.hasCoordinatorConnection,
      "second joined the mesh through the coordinator port",
    );

    await first.store.shutdown();

    await waitFor(
      () => second.transport.isCoordinator,
      "the named successor took the coordinator role",
    );

    const joiner = await startNode("joiner", port, teardown);
    await waitFor(
      () => joiner.transport.hasCoordinatorConnection,
      "a fresh store joined through the successor's coordinator port",
    );
  } finally {
    await teardown.run();
  }
});

/** How long a status change may take to reach a peer, and how often it is checked while waiting. */
const STATUS_WAIT_TIMEOUT_MS = 10_000;
const STATUS_POLL_INTERVAL_MS = 50;

/** Polls a node's own view of one agent until it reports the wanted status, since a status change reaches a peer over the wire rather than synchronously. */
async function waitForStatus(
  node: Node,
  agentId: string,
  status: AgentIdentity["status"],
): Promise<void> {
  const deadline = Date.now() + STATUS_WAIT_TIMEOUT_MS;
  while ((await agentsOf(node)).get(agentId)?.status !== status) {
    if (Date.now() >= deadline) {
      throw new Error(`${node.name} never saw ${agentId} as ${status}`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, STATUS_POLL_INTERVAL_MS);
    });
  }
}

test("a running agent stays online everywhere when the mesh is told it is offline, as happens to a session the previous coordinator was fronting", async () => {
  const port = freshCoordinatorPort();
  const teardown = new TeardownStack();
  try {
    const coordinator = await startNode("coordinator", port, teardown);
    const member = await startNode("member", port, teardown);
    await waitForStatus(coordinator, member.agentId, "active");

    await coordinator.transport.broadcast({
      method: "state_update",
      patch: { type: "agent_offline", agentId: member.agentId },
    });

    // The coordinator applied nothing itself (broadcast reaches peers only), so it holds the offline report only if the member's contradiction never came back; the member then has to have kept its own record active too.
    await waitForStatus(member, member.agentId, "active");
    await waitForStatus(coordinator, member.agentId, "active");
  } finally {
    await teardown.run();
  }
});

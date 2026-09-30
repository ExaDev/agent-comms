/**
 * The elected coordinator role over real localhost sockets (agent-comms#341): several MeshStore instances, each on its own WireMeshTransport, gossiping coordinator claims over their machine-local sessions. Asserts that exactly one store holds the role and every store agrees which, that a store which never bound the well-known port can hold it, and that the holder's loss is recovered by a survivor raising the term. The decision logic is unit-tested against fakes in coordinator-role.unit.test.ts and coordinator-failover.unit.test.ts.
 */

import * as net from "node:net";
import { test, expect } from "vitest";
import { MeshStore } from "../core/mesh-store.js";
import type { WireMeshTransport } from "../core/wire-mesh-transport.js";
import { TeardownStack, freeLocalPort } from "./hub-helpers.js";
import { waitFor, wireTestTransportWithHub } from "./test-transport.js";

interface Node {
  name: string;
  store: MeshStore;
  transport: WireMeshTransport;
  /** Every value onCoordinatorRoleChanged has been called with, in order. */
  roleChanges: boolean[];
}

async function startNode(
  name: string,
  ports: Readonly<{ coordinatorPort: number; firstContactPort?: number }>,
  teardown: TeardownStack,
): Promise<Node> {
  const store = new MeshStore(ports);
  const { transport } = await wireTestTransportWithHub(store);
  const roleChanges: boolean[] = [];
  store.onCoordinatorRoleChanged = (isCoordinator) => {
    roleChanges.push(isCoordinator);
  };
  teardown.push(async () => {
    await store.shutdown().catch(() => undefined);
  });
  await store.init();
  return { name, store, transport, roleChanges };
}

function holders(nodes: readonly Node[]): Node[] {
  return nodes.filter((node) => node.store.holdsCoordinatorRole);
}

/** Whether every node accepts the same claim and exactly one of them is the holder that claim names. */
function settledOnOneHolder(nodes: readonly Node[]): boolean {
  const [first, ...rest] = nodes;
  const claim = first?.store.coordinatorClaim;
  if (claim === undefined) return false;
  const agreed = rest.every(
    (node) =>
      node.store.coordinatorClaim?.holder === claim.holder &&
      node.store.coordinatorClaim.term === claim.term,
  );
  const held = holders(nodes);
  return agreed && held.length === 1 && held[0]?.store.peerId === claim.holder;
}

/** A TCP server on the given port that drops every connection at once, standing in for a stale process holding the well-known port: nothing on it ever answers as a port holder, and nobody else can bind it. */
async function occupyPort(
  port: number,
  teardown: TeardownStack,
): Promise<void> {
  const squatter = net.createServer((socket) => {
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    squatter.once("error", reject);
    squatter.listen(port, "127.0.0.1", () => {
      resolve();
    });
  });
  teardown.push(async () => {
    await new Promise<void>((resolve) => {
      squatter.close(() => {
        resolve();
      });
    });
  });
}

test("exactly one of three stores holds the elected coordinator role, and every store agrees which", async () => {
  const teardown = new TeardownStack();
  try {
    const coordinatorPort = await freeLocalPort();
    const first = await startNode("first", { coordinatorPort }, teardown);
    const second = await startNode("second", { coordinatorPort }, teardown);
    const third = await startNode("third", { coordinatorPort }, teardown);
    const nodes = [first, second, third];

    await waitFor(
      () => settledOnOneHolder(nodes),
      "every store accepts one claim naming a single holder",
    );

    // Only the first store was alone when it started, so it is the only one that claimed; the joiners learned its claim instead of contesting it.
    expect(first.store.holdsCoordinatorRole).toBe(true);
    expect(first.store.coordinatorClaim).toEqual({
      term: 0,
      holder: first.store.peerId,
    });
    expect(first.roleChanges).toEqual([true]);
    expect(second.roleChanges).toEqual([]);
    expect(third.roleChanges).toEqual([]);
  } finally {
    await teardown.run();
  }
});

test("a store that never bound the well-known port holds the elected role once first contact joins two stores that each claimed alone", async () => {
  const teardown = new TeardownStack();
  try {
    const coordinatorPort = await freeLocalPort();
    const firstContactPort = await freeLocalPort();
    await occupyPort(coordinatorPort, teardown);
    const ports = { coordinatorPort, firstContactPort };
    const left = await startNode("left", ports, teardown);
    const right = await startNode("right", ports, teardown);
    const nodes = [left, right];

    await waitFor(
      () => settledOnOneHolder(nodes),
      "first contact brought both claims together and one superseded the other",
    );

    expect(left.transport.isCoordinator).toBe(false);
    expect(right.transport.isCoordinator).toBe(false);
    const [holder] = holders(nodes);
    if (holder === undefined) throw new Error("expected a holder");
    // Both claimed term 0 while alone, so the equal-term tiebreak by lowest device-id decided it.
    expect(holder.store.peerId).toBe(
      [left.store.peerId, right.store.peerId].sort()[0],
    );
    expect(holder.roleChanges).toEqual([true]);
    const other = nodes.find((node) => node !== holder);
    expect(other?.roleChanges).toEqual([true, false]);
  } finally {
    await teardown.run();
  }
});

test("the holder's loss is recovered by a surviving store raising the term, and every survivor agrees on it", async () => {
  const teardown = new TeardownStack();
  try {
    const coordinatorPort = await freeLocalPort();
    const first = await startNode("first", { coordinatorPort }, teardown);
    const second = await startNode("second", { coordinatorPort }, teardown);
    const third = await startNode("third", { coordinatorPort }, teardown);
    await waitFor(
      () => settledOnOneHolder([first, second, third]),
      "the mesh settled on the first store as holder before it is lost",
    );
    const lostTerm = first.store.coordinatorClaim?.term;
    expect(first.store.holdsCoordinatorRole).toBe(true);

    // A crash, not a shutdown: the transport goes down without the store giving anything up, as when the process is killed.
    await first.transport.shutdown();

    const survivors = [second, third];
    await waitFor(
      () => settledOnOneHolder(survivors),
      "the survivors settled on one new holder",
    );
    const claim = second.store.coordinatorClaim;
    expect(claim?.term).toBe((lostTerm ?? 0) + 1);
    expect(claim?.holder).toBe(
      [second.store.peerId, third.store.peerId].sort()[0],
    );
    const [holder] = holders(survivors);
    expect(holder?.roleChanges).toEqual([true]);
  } finally {
    await teardown.run();
  }
});

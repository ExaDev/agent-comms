/**
 * The elected coordinator role over real localhost sockets (agent-comms#341): several MeshStore instances, each on its own WireMeshTransport, gossiping coordinator claims over their machine-local sessions. Asserts that exactly one store holds the role and every store agrees which, that a store which never bound the well-known port can hold it and keeps it when lower-id stores arrive, that stores which each claimed alone converge, and that the holder's loss is recovered by a survivor raising the term. Which sessions a claim is accepted from is covered by coordinator-claim-sessions.integration.test.ts; the decision logic is unit-tested against fakes in coordinator-role.unit.test.ts and coordinator-failover.unit.test.ts.
 */

import * as net from "node:net";
import { test, expect } from "vitest";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { generateIdentity, type PeerIdentity } from "../core/identity.js";
import { MeshStore } from "../core/mesh-store.js";
import type { MeshStoreOptions } from "../core/mesh-store-options.js";
import type { WireMeshTransport } from "../core/wire-mesh-transport.js";
import { TeardownStack, freeLocalPort } from "./hub-helpers.js";
import { waitFor, wireTestTransportWithHub } from "./test-transport.js";

/** A claim wait for a store the test starts with nobody else to meet: there is no incumbent it could hear, so waiting any longer would only slow the test. */
const NOTHING_TO_WAIT_FOR_MS = 0;

interface Node {
  name: string;
  store: MeshStore;
  transport: WireMeshTransport;
  /** Every value onCoordinatorRoleChanged has been called with, in order. */
  roleChanges: boolean[];
}

async function startNode(
  name: string,
  options: Readonly<MeshStoreOptions>,
  teardown: TeardownStack,
  identity?: PeerIdentity,
): Promise<Node> {
  const store = new MeshStore(options);
  const { transport } = await wireTestTransportWithHub(
    store,
    identity === undefined ? undefined : { identityLoader: () => identity },
  );
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

/** Three fresh identities, in ascending device-id order. */
function identitiesByDeviceId(): [PeerIdentity, PeerIdentity, PeerIdentity] {
  const hex = (identity: PeerIdentity): string =>
    deviceIdToHex(Uint8Array.from(identity.deviceId));
  const [lowest, middle, highest] = [
    generateIdentity(),
    generateIdentity(),
    generateIdentity(),
  ].sort((a, b) => (hex(a) < hex(b) ? -1 : 1));
  if (lowest === undefined || middle === undefined || highest === undefined) {
    throw new Error("expected three identities");
  }
  return [lowest, middle, highest];
}

test("an existing mesh behind a squatted port keeps its holder when a lower-id store joins through first contact", async () => {
  const teardown = new TeardownStack();
  try {
    const coordinatorPort = await freeLocalPort();
    const firstContactPort = await freeLocalPort();
    await occupyPort(coordinatorPort, teardown);
    const [lowest, middle, highest] = identitiesByDeviceId();
    const holder = await startNode(
      "holder",
      {
        coordinatorPort,
        firstContactPort,
        coordinatorClaimWaitMs: NOTHING_TO_WAIT_FOR_MS,
      },
      teardown,
      highest,
    );
    await waitFor(
      () => holder.store.holdsCoordinatorRole,
      "the store started alone behind the squatted port claims the role",
    );
    // The joiners keep the default claim wait, which is what gives the holder's announcement time to reach each of them over first contact before it would claim.
    const member = await startNode(
      "member",
      { coordinatorPort, firstContactPort },
      teardown,
      middle,
    );
    await waitFor(
      () => settledOnOneHolder([holder, member]),
      "the second store learned the incumbent through first contact",
    );

    const newcomer = await startNode(
      "newcomer",
      { coordinatorPort, firstContactPort },
      teardown,
      lowest,
    );
    const nodes = [holder, member, newcomer];
    await waitFor(
      () => settledOnOneHolder(nodes),
      "the newcomer learned the incumbent through first contact",
    );

    expect(newcomer.store.peerId < member.store.peerId).toBe(true);
    expect(member.store.peerId < holder.store.peerId).toBe(true);
    for (const node of nodes) {
      expect(node.transport.isCoordinator).toBe(false);
      expect(node.store.coordinatorClaim).toEqual({
        term: 0,
        holder: holder.store.peerId,
      });
    }
    expect(holder.roleChanges).toEqual([true]);
    expect(member.roleChanges).toEqual([]);
    expect(newcomer.roleChanges).toEqual([]);
  } finally {
    await teardown.run();
  }
});

test("two stores that each claimed alone behind a squatted port converge on the lower device-id once first contact joins them", async () => {
  const teardown = new TeardownStack();
  try {
    const coordinatorPort = await freeLocalPort();
    const firstContactPort = await freeLocalPort();
    await occupyPort(coordinatorPort, teardown);
    const options = {
      coordinatorPort,
      firstContactPort,
      coordinatorClaimWaitMs: NOTHING_TO_WAIT_FOR_MS,
    };
    const left = await startNode("left", options, teardown);
    const right = await startNode("right", options, teardown);
    const nodes = [left, right];

    await waitFor(
      () => settledOnOneHolder(nodes),
      "first contact brought both claims together and one superseded the other",
    );

    const [holder] = holders(nodes);
    if (holder === undefined) throw new Error("expected a holder");
    // Both claimed term 0 while alone, so the equal-term tiebreak by lowest device-id decided it.
    expect(holder.store.peerId).toBe(
      [left.store.peerId, right.store.peerId].sort()[0],
    );
    expect(holder.store.coordinatorClaim?.term).toBe(0);
    expect(holder.roleChanges).toEqual([true]);
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

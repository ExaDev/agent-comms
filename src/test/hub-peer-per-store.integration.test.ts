/**
 * Integration tests for every store being its own peer on the relay hub (agent-comms#293), the cross-machine leg of the mesh epic (#153). Two independent local meshes ("machine A" and "machine B") on a shared real relay hub (createRelayHub, the same domain logic the production mesh.exadev.io Durable Object runs, served over local WebSockets via hub-helpers.ts): neither mesh is ever directly connected to the other, so anything either side learns about the other arrived via the hub.
 *
 * Machine A has a coordinator (a1) and an ordinary local peer (a2). The point of the tests is that a2, which is not the coordinator, is reachable and can reach out with its own identity, exactly as a1 is: no store depends on the coordinator to speak to another machine.
 *
 * Trust is deny-all by default (agent-comms#156), so every test trusts the specific device ids it needs. See gateway-trust.integration.test.ts for the deny-by-default behaviour itself.
 */

import { afterEach, describe, expect, it } from "vitest";
import { MeshStore } from "../core/mesh-store.js";
import { dmRoomPath } from "../core/room-path.js";
import type { Visibility } from "../core/types.js";
import { realHubOverWs, TeardownStack } from "./hub-helpers.js";
import { wireTestTransport } from "./test-transport.js";

let nextPort = 22_400;
function freshPort(): number {
  nextPort += 1;
  return nextPort;
}

/** Short enough that a gossip re-advertisement (which carries the registerAgent'd agent/self extension) fires within a test's own poll budget, unlike the 20s production default. */
const FAST_GOSSIP_INTERVAL_MS = 50;

const POLL_ATTEMPTS = 100;
const POLL_INTERVAL_MS = 50;
const sleep = async (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Polls an async predicate until it holds, matching broadcast-window.integration.test.ts's own established pattern for this -- the shared test-transport.ts waitFor takes a synchronous condition, which can't await a MeshStore's own async listAgents/serialise-derived checks. */
async function waitFor(
  what: string,
  check: () => Promise<boolean>,
): Promise<void> {
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    if (await check()) return;
    await sleep(POLL_INTERVAL_MS);
  }
  expect(false, `timed out waiting for ${what}`).toBeTruthy();
}

const cleanups = new TeardownStack();

afterEach(async () => {
  await cleanups.run();
});

/** Starts one store on the local mesh at coordinatorPort, dialling hubUrl itself, and registers a visible agent for it unless told otherwise. */
async function startStore(
  options: Readonly<{
    coordinatorPort: number;
    hubUrl: string;
    name: string;
    visibility?: Visibility;
  }>,
): Promise<MeshStore> {
  const { coordinatorPort, hubUrl, name, visibility = "visible" } = options;
  const store = new MeshStore({ coordinatorPort, hubUrl });
  await wireTestTransport(store, {
    presenceReadvertiseIntervalMs: FAST_GOSSIP_INTERVAL_MS,
  });
  await store.init();
  cleanups.push(async () => store.shutdown());
  await store.registerAgent({
    name,
    harness: "test",
    cwd: `/test/${name}`,
    pid: process.pid,
    visibility,
    tags: [name],
  });
  return store;
}

describe("every store is its own hub peer", () => {
  it("discovers a store that is not its machine's coordinator from another machine, with the agent's own fields", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);

    const a1 = await startStore({
      coordinatorPort: freshPort(),
      hubUrl: hub.url,
      name: "a1",
    });
    const a2 = await startStore({
      coordinatorPort: a1.coordinatorPort,
      hubUrl: hub.url,
      name: "a2",
    });
    const b1 = await startStore({
      coordinatorPort: freshPort(),
      hubUrl: hub.url,
      name: "b1",
    });

    a2.addTrustedGateway(b1.peerId);
    b1.addTrustedGateway(a2.peerId);

    await waitFor("b1 to learn of a2 via the hub", async () => {
      const agents = await b1.listAgents(b1.peerId);
      return agents.some((agent) => agent.id === a2.peerId);
    });

    const discovered = (await b1.listAgents(b1.peerId)).find(
      (agent) => agent.id === a2.peerId,
    );
    expect(discovered).toMatchObject({
      id: a2.peerId,
      name: "a2",
      harness: "test",
      cwd: "/test/a2",
      visibility: "visible",
      tags: ["a2"],
    });
  });

  it("lets a store that is not its machine's coordinator see a remote agent", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);

    const a1 = await startStore({
      coordinatorPort: freshPort(),
      hubUrl: hub.url,
      name: "a1",
    });
    const a2 = await startStore({
      coordinatorPort: a1.coordinatorPort,
      hubUrl: hub.url,
      name: "a2",
    });
    const b1 = await startStore({
      coordinatorPort: freshPort(),
      hubUrl: hub.url,
      name: "b1",
    });

    a2.addTrustedGateway(b1.peerId);
    b1.addTrustedGateway(a2.peerId);

    await waitFor("a2 to learn of b1 via the hub", async () => {
      const agents = await a2.listAgents(a2.peerId);
      return agents.some((agent) => agent.id === b1.peerId);
    });
  });

  it("never advertises a hidden or ghost agent across the hub", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);

    const a1 = await startStore({
      coordinatorPort: freshPort(),
      hubUrl: hub.url,
      name: "a1",
    });
    const aHidden = await startStore({
      coordinatorPort: a1.coordinatorPort,
      hubUrl: hub.url,
      name: "hidden-peer",
      visibility: "hidden",
    });
    const aGhost = await startStore({
      coordinatorPort: a1.coordinatorPort,
      hubUrl: hub.url,
      name: "ghost-peer",
      visibility: "ghost",
    });
    // A visible control peer registered after the hidden and ghost ones: its arrival on b1's side proves gossip had time to propagate, ruling out "nothing arrived at all" as a false-negative explanation.
    const aVisible = await startStore({
      coordinatorPort: a1.coordinatorPort,
      hubUrl: hub.url,
      name: "visible-peer",
    });
    const b1 = await startStore({
      coordinatorPort: freshPort(),
      hubUrl: hub.url,
      name: "b1",
    });

    // Every store trusts b1 and b1 trusts every one of them, so trust is never the reason a hidden or ghost agent fails to appear.
    for (const store of [a1, aHidden, aGhost, aVisible]) {
      store.addTrustedGateway(b1.peerId);
      b1.addTrustedGateway(store.peerId);
    }

    await waitFor(
      "b1 to see the visible control peer, proving gossip had time to propagate",
      async () => {
        const agents = await b1.listAgents(b1.peerId);
        return agents.some((agent) => agent.id === aVisible.peerId);
      },
    );

    const agents = await b1.listAgents(b1.peerId);
    expect(agents.some((agent) => agent.id === aHidden.peerId)).toBe(false);
    expect(agents.some((agent) => agent.id === aGhost.peerId)).toBe(false);
  });

  it("delivers a direct message from a store that is not its machine's coordinator, attributed to that store's own agent", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);

    const a1 = await startStore({
      coordinatorPort: freshPort(),
      hubUrl: hub.url,
      name: "a1",
    });
    const a2 = await startStore({
      coordinatorPort: a1.coordinatorPort,
      hubUrl: hub.url,
      name: "a2",
    });
    const b1 = await startStore({
      coordinatorPort: freshPort(),
      hubUrl: hub.url,
      name: "b1",
    });

    // Mutual trust: b1 must trust a2 to accept a2's request, and a2 must trust b1 to route to it at all.
    a2.addTrustedGateway(b1.peerId);
    b1.addTrustedGateway(a2.peerId);

    await waitFor("a2 to learn of b1 via the hub", async () => {
      const agents = await a2.listAgents(a2.peerId);
      return agents.some((agent) => agent.id === b1.peerId);
    });

    // Two-round DM consent, exactly like the local-mesh-only dm-admission.integration.test.ts.
    const dmPath = dmRoomPath(a2.peerId, b1.peerId);
    const requestPromise = a2.requestDmAccess(b1.peerId);
    await waitFor("b1 to see a2's pending DM request via the hub", async () => {
      await Promise.resolve();
      return b1.listPendingRoomJoins().length === 1;
    });
    const [pending] = b1.listPendingRoomJoins();
    expect(pending?.roomPath).toBe(dmPath);
    expect(pending?.requesterId).toBe(a2.peerId);
    b1.acceptRoomJoin(dmPath, a2.peerId);
    await requestPromise;

    const message = await a2.sendDm(a2.peerId, b1.peerId, "hello from a2");

    await waitFor("b1 to receive the DM via the hub", async () => {
      const b1Dms = b1.serialise().dms[dmPath] ?? [];
      return b1Dms.some((m) => m.id === message.message.id);
    });

    const delivered = (b1.serialise().dms[dmPath] ?? []).find(
      (m) => m.id === message.message.id,
    );
    expect(delivered).toMatchObject({
      from: a2.peerId,
      to: b1.peerId,
      content: "hello from a2",
    });
  });
});

/**
 * Integration tests for the gateway actually forwarding between the local mesh and the hub (agent-comms#155), the core leg of the cross-machine mesh epic (#153) on top of #154's own connection-lifecycle-only gateway. Two independent local meshes ("machine A" and "machine B"), each its own coordinator dialling a shared real relay hub (createRelayHub, the same domain logic the production mesh.exadev.io Durable Object runs, served over local WebSockets via hub-helpers.ts) -- neither mesh is ever directly connected to the other, so anything either side learns about the other can only have arrived via the hub.
 *
 * Machine A's coordinator (a1) additionally has a second, ordinary local peer (a2) -- proving outbound advertisement and the remote-directory merge work for a local peer that is NOT itself the gateway, not just for the gateway's own agent (which #154 already exercised end-to-end before this issue).
 */

import { afterEach, describe, expect, it } from "vitest";
import { MeshStore } from "../core/mesh-store.js";
import { dmRoomPath } from "../core/room-path.js";
import { realHubOverWs } from "./hub-helpers.js";
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

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanups.splice(0)) {
    await close();
  }
});

describe("gateway forwarding", () => {
  it("advertises a local peer's agent (not just the gateway's own) onto the hub, and a separate machine's gateway merges it into its own knownDevices/listAgents", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);

    const a1 = new MeshStore(freshPort(), hub.url);
    await wireTestTransport(a1, undefined, undefined, FAST_GOSSIP_INTERVAL_MS);
    await a1.init();
    cleanups.push(async () => a1.shutdown());

    const a2 = new MeshStore(a1.coordinatorPort, hub.url);
    await wireTestTransport(a2, undefined, undefined, FAST_GOSSIP_INTERVAL_MS);
    await a2.init();
    cleanups.push(async () => a2.shutdown());
    await a2.registerAgent({
      name: "a2-local-peer",
      harness: "test",
      cwd: "/test/a2",
      pid: process.pid,
      visibility: "visible",
      tags: ["from-a2"],
    });

    const b1 = new MeshStore(freshPort(), hub.url);
    await wireTestTransport(b1, undefined, undefined, FAST_GOSSIP_INTERVAL_MS);
    await b1.init();
    cleanups.push(async () => b1.shutdown());

    await waitFor(
      "b1 (a separate machine's gateway) to learn of a2 (a non-gateway local peer on machine A) via the hub",
      async () => {
        const agents = await b1.listAgents(b1.peerId);
        return agents.some((agent) => agent.id === a2.peerId);
      },
    );

    const agents = await b1.listAgents(b1.peerId);
    const discovered = agents.find((agent) => agent.id === a2.peerId);
    expect(discovered).toMatchObject({
      id: a2.peerId,
      name: "a2-local-peer",
      harness: "test",
      cwd: "/test/a2",
      visibility: "visible",
      tags: ["from-a2"],
    });
  });

  it("never advertises a hidden or ghost agent across the hub", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);

    const a1 = new MeshStore(freshPort(), hub.url);
    await wireTestTransport(a1, undefined, undefined, FAST_GOSSIP_INTERVAL_MS);
    await a1.init();
    cleanups.push(async () => a1.shutdown());

    const aHidden = new MeshStore(a1.coordinatorPort, hub.url);
    await wireTestTransport(
      aHidden,
      undefined,
      undefined,
      FAST_GOSSIP_INTERVAL_MS,
    );
    await aHidden.init();
    cleanups.push(async () => aHidden.shutdown());
    await aHidden.registerAgent({
      name: "hidden-peer",
      harness: "test",
      cwd: "/test/hidden",
      pid: process.pid,
      visibility: "hidden",
      tags: [],
    });

    const aGhost = new MeshStore(a1.coordinatorPort, hub.url);
    await wireTestTransport(
      aGhost,
      undefined,
      undefined,
      FAST_GOSSIP_INTERVAL_MS,
    );
    await aGhost.init();
    cleanups.push(async () => aGhost.shutdown());
    await aGhost.registerAgent({
      name: "ghost-peer",
      harness: "test",
      cwd: "/test/ghost",
      pid: process.pid,
      visibility: "ghost",
      tags: [],
    });

    // A visible control peer on the identical mesh, registered after the hidden/ghost ones -- its own arrival on b1's side is the proof gossip genuinely had time to propagate, ruling out "nothing arrived at all" as a false-negative explanation for hidden/ghost never showing up below.
    const aVisible = new MeshStore(a1.coordinatorPort, hub.url);
    await wireTestTransport(
      aVisible,
      undefined,
      undefined,
      FAST_GOSSIP_INTERVAL_MS,
    );
    await aVisible.init();
    cleanups.push(async () => aVisible.shutdown());
    await aVisible.registerAgent({
      name: "visible-peer",
      harness: "test",
      cwd: "/test/visible",
      pid: process.pid,
      visibility: "visible",
      tags: [],
    });

    const b1 = new MeshStore(freshPort(), hub.url);
    await wireTestTransport(b1, undefined, undefined, FAST_GOSSIP_INTERVAL_MS);
    await b1.init();
    cleanups.push(async () => b1.shutdown());

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

  it("routes a DM to a remote gateway's own agent through the hub's relay pairing, delivered with the true sender attributed", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);

    const a1 = new MeshStore(freshPort(), hub.url);
    await wireTestTransport(a1, undefined, undefined, FAST_GOSSIP_INTERVAL_MS);
    await a1.init();
    cleanups.push(async () => a1.shutdown());
    await a1.registerAgent({
      name: "a1-gateway",
      harness: "test",
      cwd: "/test/a1",
      pid: process.pid,
      visibility: "visible",
      tags: [],
    });

    const b1 = new MeshStore(freshPort(), hub.url);
    await wireTestTransport(b1, undefined, undefined, FAST_GOSSIP_INTERVAL_MS);
    await b1.init();
    cleanups.push(async () => b1.shutdown());
    await b1.registerAgent({
      name: "b1-gateway",
      harness: "test",
      cwd: "/test/b1",
      pid: process.pid,
      visibility: "visible",
      tags: [],
    });

    // Two-round DM consent (section 6), exactly like the local-mesh-only dm-admission.integration.test.ts -- b1's own outbound request is what's actually exercised via the new hub-relay fallback, since a1 is not a local peer of b1's own mesh.
    const dmPath = dmRoomPath(b1.peerId, a1.peerId);
    const requestPromise = b1.requestDmAccess(a1.peerId);
    await waitFor("a1 to see b1's pending DM request via the hub", async () => {
      await Promise.resolve();
      return a1.listPendingRoomJoins().length === 1;
    });
    const [pending] = a1.listPendingRoomJoins();
    expect(pending?.roomPath).toBe(dmPath);
    expect(pending?.requesterId).toBe(b1.peerId);
    a1.acceptRoomJoin(dmPath, b1.peerId);
    await requestPromise;

    const message = await b1.sendDm(b1.peerId, a1.peerId, "hello from b1");

    await waitFor("a1 to receive the DM via the hub", async () => {
      const a1Dms = a1.serialise().dms[dmPath] ?? [];
      return a1Dms.some((m) => m.id === message.id);
    });

    const delivered = (a1.serialise().dms[dmPath] ?? []).find(
      (m) => m.id === message.id,
    );
    expect(delivered).toMatchObject({
      from: b1.peerId,
      to: a1.peerId,
      content: "hello from b1",
    });
  });
});

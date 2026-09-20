/**
 * Integration test for agent-comms#184: a hub-relayed manage-request explicitly addressed (relay-data's own `to-device` field, surfaced as `IncomingManageRequest.toDevice` since wire-mesh#170, wire-mesh-core 1.48.1) to a NON-gateway local peer must be routed on to that peer's own local mesh session, not dispatched against the gateway's own local state the way gateway-forwarding.integration.test.ts's "routes a DM to a remote gateway's own agent" case already covers for the gateway itself. Also proves the request's true remote origin (b1) survives the forwarding hop intact -- room-router.ts's own "on-behalf-of" mechanism, not just delivery reaching the right recipient.
 *
 * Same three-party shape as gateway-forwarding.integration.test.ts: machine A has a coordinator (a1, the gateway, dialled to the hub) and a second, ordinary local peer (a2) that is never itself connected to the hub. Machine B (b1) reaches a2 purely through the hub's relay pairing with a1 -- if toDevice routing didn't exist, b1's request would land at a1's own DM state instead of a2's, since a1's hub session has no way to tell the two apart.
 */

import { afterEach, describe, expect, it } from "vitest";
import { MeshStore } from "../core/mesh-store.js";
import { dmRoomPath } from "../core/room-path.js";
import { realHubOverWs, TeardownStack } from "./hub-helpers.js";
import { wireTestTransport } from "./test-transport.js";

let nextPort = 22_500;
function freshPort(): number {
  nextPort += 1;
  return nextPort;
}

/** Short enough that a gossip re-advertisement (which carries a1's forwarded advert of a2) fires within a test's own poll budget, matching gateway-forwarding.integration.test.ts's own choice. */
const FAST_GOSSIP_INTERVAL_MS = 50;

const POLL_ATTEMPTS = 100;
const POLL_INTERVAL_MS = 50;
const sleep = async (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Polls an async predicate until it holds -- gateway-forwarding.integration.test.ts's own established pattern for this, duplicated here rather than shared, since neither file exports it. */
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

describe("hub toDevice routing", () => {
  it("routes a DM addressed to a non-gateway local peer to that peer's own state, not the gateway's", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);

    const a1 = new MeshStore({ coordinatorPort: freshPort(), hubUrl: hub.url });
    await wireTestTransport(a1, {
      presenceReadvertiseIntervalMs: FAST_GOSSIP_INTERVAL_MS,
    });
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

    const a2 = new MeshStore({
      coordinatorPort: a1.coordinatorPort,
      hubUrl: hub.url,
    });
    await wireTestTransport(a2, {
      presenceReadvertiseIntervalMs: FAST_GOSSIP_INTERVAL_MS,
    });
    await a2.init();
    cleanups.push(async () => a2.shutdown());
    await a2.registerAgent({
      name: "a2-local-peer",
      harness: "test",
      cwd: "/test/a2",
      pid: process.pid,
      visibility: "visible",
      tags: [],
    });

    const b1 = new MeshStore({ coordinatorPort: freshPort(), hubUrl: hub.url });
    await wireTestTransport(b1, {
      presenceReadvertiseIntervalMs: FAST_GOSSIP_INTERVAL_MS,
    });
    await b1.init();
    cleanups.push(async () => b1.shutdown());
    await b1.registerAgent({
      name: "b1-remote",
      harness: "test",
      cwd: "/test/b1",
      pid: process.pid,
      visibility: "visible",
      tags: [],
    });

    // Deny-all by default (agent-comms#156): a1 needs a trusted remote gateway to forward a2's advert onto the hub at all (forwardAdvertsToHub's own hasAny gate), b1 needs a2's own device-id specifically trusted for sendRoomRequest's own outbound isTrusted gate to route to it via the hub, and a1 needs b1 trusted for consume()'s own inbound gate on the relayed request's fromDevice.
    a1.addTrustedGateway(b1.peerId);
    b1.addTrustedGateway(a2.peerId);

    // Waits for b1 to actually learn of a2 via the hub's own gossip/catch-up (mirroring gateway-forwarding.integration.test.ts's own first test) before addressing a request to it -- otherwise the relay hub has no adjacency entry for a2's device yet and silently drops the relay-connect (spec/relay-hub's own documented behaviour for an unknown target-device), which would time out for a reason unrelated to toDevice routing itself.
    await waitFor("b1 to learn of a2 via the hub", async () => {
      const agents = await b1.listAgents(b1.peerId);
      return agents.some((agent) => agent.id === a2.peerId);
    });

    const dmPath = dmRoomPath(b1.peerId, a2.peerId);
    const requestPromise = b1.requestDmAccess(a2.peerId);
    await waitFor(
      "a2 (not a1) to see b1's pending DM request, routed through a1's hub session via toDevice",
      async () => {
        await Promise.resolve();
        return a2.listPendingRoomJoins().length === 1;
      },
    );
    const [pending] = a2.listPendingRoomJoins();
    expect(pending?.roomPath).toBe(dmPath);
    expect(pending?.requesterId).toBe(b1.peerId);
    // The gateway's own DM state must never have seen this request: proves toDevice routing actually redirected it to a2 rather than a1 additionally absorbing a copy.
    expect(a1.listPendingRoomJoins()).toHaveLength(0);

    a2.acceptRoomJoin(dmPath, b1.peerId);
    await requestPromise;

    const message = await b1.sendDm(b1.peerId, a2.peerId, "hello from b1");

    await waitFor(
      "a2 to receive the DM via the hub, routed through a1",
      async () => {
        const a2Dms = a2.serialise().dms[dmPath] ?? [];
        return a2Dms.some((m) => m.id === message.id);
      },
    );

    const delivered = (a2.serialise().dms[dmPath] ?? []).find(
      (m) => m.id === message.id,
    );
    expect(delivered).toMatchObject({
      from: b1.peerId,
      to: a2.peerId,
      content: "hello from b1",
    });
    // Again: the gateway's own DM state must stay empty throughout -- the message belongs to a2, never a1.
    expect(a1.serialise().dms[dmPath] ?? []).toHaveLength(0);
  });
});

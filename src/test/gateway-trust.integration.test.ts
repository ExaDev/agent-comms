/**
 * Integration tests for the gateway allowlist's own deny-by-default posture (agent-comms#156), the trust-boundary leg of the cross-machine mesh epic (#153) on top of #155's own (now trust-gated) forwarding. Same two-independent-local-meshes-over-a-real-hub harness as gateway-forwarding.integration.test.ts, but every scenario here proves the ABSENCE of forwarding/merge/routing before any trust is established, complementing that file's own coverage of the PRESENT-trust happy path.
 */

import { afterEach, describe, expect, it } from "vitest";
import { MeshStore } from "../core/mesh-store.js";
import { realHubOverWs } from "./hub-helpers.js";
import { wireTestTransport } from "./test-transport.js";

let nextPort = 22_500;
function freshPort(): number {
  nextPort += 1;
  return nextPort;
}

/** Short enough that a gossip re-advertisement fires within a test's own poll budget, matching gateway-forwarding.integration.test.ts's own choice. */
const FAST_GOSSIP_INTERVAL_MS = 50;

const POLL_ATTEMPTS = 100;
const POLL_INTERVAL_MS = 50;
const sleep = async (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

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

describe("gateway trust -- deny by default", () => {
  it("never merges a remote agent's directory entry when this side hasn't trusted it, even once a trusted control agent proves propagation had time", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);

    const a1 = new MeshStore({ coordinatorPort: freshPort(), hubUrl: hub.url });
    await wireTestTransport(a1, {
      presenceReadvertiseIntervalMs: FAST_GOSSIP_INTERVAL_MS,
    });
    await a1.init();
    cleanups.push(async () => a1.shutdown());
    await a1.registerAgent({
      name: "untrusted-a1",
      harness: "test",
      cwd: "/test/a1",
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

    const c1 = new MeshStore({ coordinatorPort: freshPort(), hubUrl: hub.url });
    await wireTestTransport(c1, {
      presenceReadvertiseIntervalMs: FAST_GOSSIP_INTERVAL_MS,
    });
    await c1.init();
    cleanups.push(async () => c1.shutdown());
    await c1.registerAgent({
      name: "trusted-control-c1",
      harness: "test",
      cwd: "/test/c1",
      pid: process.pid,
      visibility: "visible",
      tags: [],
    });

    // a1 needs at least one trusted device to forward at all (the outbound gate); c1 fills that role so a1's own gossip reaches the hub, without ever trusting b1 specifically. b1 trusts c1 (proving propagation genuinely had time) but never trusts a1.
    a1.addTrustedGateway(c1.peerId);
    c1.addTrustedGateway(a1.peerId);
    b1.addTrustedGateway(c1.peerId);
    c1.addTrustedGateway(b1.peerId);

    await waitFor("b1 to see the trusted control agent c1", async () => {
      const agents = await b1.listAgents(b1.peerId);
      return agents.some((agent) => agent.id === c1.peerId);
    });

    const agents = await b1.listAgents(b1.peerId);
    expect(agents.some((agent) => agent.id === a1.peerId)).toBe(false);
  });

  it("never advertises anything onto the hub while this side has trusted nobody, even for a peer another side would have accepted", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);

    const a1 = new MeshStore({ coordinatorPort: freshPort(), hubUrl: hub.url });
    await wireTestTransport(a1, {
      presenceReadvertiseIntervalMs: FAST_GOSSIP_INTERVAL_MS,
    });
    await a1.init();
    cleanups.push(async () => a1.shutdown());
    await a1.registerAgent({
      name: "never-advertised-a1",
      harness: "test",
      cwd: "/test/a1",
      pid: process.pid,
      visibility: "visible",
      tags: [],
    });
    // a1 trusts nobody at all -- the outbound gate (hasAny) should withhold every advertisement.

    const b1 = new MeshStore({ coordinatorPort: freshPort(), hubUrl: hub.url });
    await wireTestTransport(b1, {
      presenceReadvertiseIntervalMs: FAST_GOSSIP_INTERVAL_MS,
    });
    await b1.init();
    cleanups.push(async () => b1.shutdown());
    b1.addTrustedGateway(a1.peerId);

    const c1 = new MeshStore({ coordinatorPort: freshPort(), hubUrl: hub.url });
    await wireTestTransport(c1, {
      presenceReadvertiseIntervalMs: FAST_GOSSIP_INTERVAL_MS,
    });
    await c1.init();
    cleanups.push(async () => c1.shutdown());
    await c1.registerAgent({
      name: "trusted-control-c1",
      harness: "test",
      cwd: "/test/c1",
      pid: process.pid,
      visibility: "visible",
      tags: [],
    });
    b1.addTrustedGateway(c1.peerId);
    c1.addTrustedGateway(b1.peerId);

    await waitFor(
      "b1 to see c1, proving gossip had time to reach it",
      async () => {
        const agents = await b1.listAgents(b1.peerId);
        return agents.some((agent) => agent.id === c1.peerId);
      },
    );

    const agents = await b1.listAgents(b1.peerId);
    expect(agents.some((agent) => agent.id === a1.peerId)).toBe(false);
  });

  it("refuses to route a request to an untrusted remote device, without ever reaching the hub", async () => {
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

    const b1 = new MeshStore({ coordinatorPort: freshPort(), hubUrl: hub.url });
    await wireTestTransport(b1, {
      presenceReadvertiseIntervalMs: FAST_GOSSIP_INTERVAL_MS,
    });
    await b1.init();
    cleanups.push(async () => b1.shutdown());
    // b1 never trusts a1 -- requestDmAccess must be refused fast, not hang out sendRoomRequest's own hub timeout.

    await expect(b1.requestDmAccess(a1.peerId)).rejects.toThrow(/unauthorized/);
  });
});

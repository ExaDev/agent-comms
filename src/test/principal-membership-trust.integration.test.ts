/**
 * Integration tests for trusting a person once instead of every device they run (agent-comms#266). Two machines meet through a real hub, each trusting only the other's user principal and no device by id. A device is trusted because its gossiped advert carries a proof the trusted principal vouches for it, so it shows up in listAgents and can be sent a DM, while a device of a principal nobody trusted stays invisible.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { MeshStore } from "../core/mesh-store.js";
import { dmRoomPath } from "../core/room-path.js";
import { realHubOverWs, TeardownStack } from "./hub-helpers.js";
import { wireTestTransport } from "./test-transport.js";

let nextPort = 26_400;
function freshPort(): number {
  nextPort += 1;
  return nextPort;
}

/** Short enough that a gossip re-advertisement fires within a test's own poll budget. */
const FAST_GOSSIP_INTERVAL_MS = 50;
const POLL_ATTEMPTS = 100;
const POLL_INTERVAL_MS = 50;
/** How long a device that must stay invisible is watched for, several gossip rounds. */
const ABSENCE_WATCH_MS = 1500;

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

const cleanups = new TeardownStack();
const dirs: string[] = [];

afterEach(async () => {
  await cleanups.run();
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function userDir(): string {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "principal-trust-user-"));
  dirs.push(dir);
  return dir;
}

/** One machine's store: `userDir` is that account's user identity, shared by every store given the same one. */
async function machineStore(
  hubUrl: string,
  coordinatorPort: number,
  userIdentityDir: string,
): Promise<MeshStore> {
  const store = new MeshStore({ coordinatorPort, hubUrl });
  await wireTestTransport(store, {
    presenceReadvertiseIntervalMs: FAST_GOSSIP_INTERVAL_MS,
    userIdentityOptions: { dir: userIdentityDir },
  });
  await store.init();
  cleanups.push(async () => store.shutdown());
  return store;
}

function principalOf(store: MeshStore): string {
  const principal = store.getUserPrincipalId();
  if (principal === undefined) throw new Error("store has no identity yet");
  return principal;
}

async function register(store: MeshStore, name: string): Promise<void> {
  await store.registerAgent({
    name,
    harness: "test",
    cwd: `/test/${name}`,
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
}

describe("principal membership trust", () => {
  it("shows a trusted principal's device without that device being trusted by id, and lets it be sent a DM", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);
    const dirA = userDir();
    const dirB = userDir();

    // Machine A: a gateway and a separate local agent, both under the same account.
    const a1 = await machineStore(hub.url, freshPort(), dirA);
    const a2 = await machineStore(hub.url, a1.coordinatorPort, dirA);
    await register(a2, "a2-local-agent");
    // Machine B: its own gateway and agent, a different account.
    const b1 = await machineStore(hub.url, freshPort(), dirB);
    await register(b1, "b1-remote");

    // Each side trusts only the other's principal. No device id is trusted anywhere.
    a1.addTrustedGatewayPrincipal(principalOf(b1));
    b1.addTrustedGatewayPrincipal(principalOf(a1));
    expect(b1.listTrustedGateways()).toEqual([]);

    await waitFor("b1 to see a2 through the hub", async () => {
      const agents = await b1.listAgents(b1.peerId);
      return agents.some((agent) => agent.id === a2.peerId);
    });

    const dmPath = dmRoomPath(b1.peerId, a2.peerId);
    const request = b1.requestDmAccess(a2.peerId);
    await waitFor("a2 to see b1's pending request", async () => {
      await Promise.resolve();
      return a2.listPendingRoomJoins().length === 1;
    });
    a2.acceptRoomJoin(dmPath, b1.peerId);
    await request;
  });

  it("does not show a device whose principal nobody trusted", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);
    const dirA = userDir();
    const dirB = userDir();
    const dirStranger = userDir();

    const a1 = await machineStore(hub.url, freshPort(), dirA);
    const a2 = await machineStore(hub.url, a1.coordinatorPort, dirA);
    await register(a2, "a2-local-agent");
    const b1 = await machineStore(hub.url, freshPort(), dirB);
    const stranger = await machineStore(hub.url, freshPort(), dirStranger);
    await register(stranger, "stranger");

    a1.addTrustedGatewayPrincipal(principalOf(b1));
    // b1 trusts A's principal and nothing else, and the stranger's gateway trusts b1's so it advertises.
    b1.addTrustedGatewayPrincipal(principalOf(a1));
    stranger.addTrustedGatewayPrincipal(principalOf(b1));

    await waitFor("b1 to see a2", async () => {
      const agents = await b1.listAgents(b1.peerId);
      return agents.some((agent) => agent.id === a2.peerId);
    });
    await sleep(ABSENCE_WATCH_MS);

    const agents = await b1.listAgents(b1.peerId);
    expect(agents.some((agent) => agent.id === stranger.peerId)).toBe(false);
  });

  it("lists a device trusted this way, and says which principal vouches for it", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);
    const dirA = userDir();
    const dirB = userDir();

    const a1 = await machineStore(hub.url, freshPort(), dirA);
    const a2 = await machineStore(hub.url, a1.coordinatorPort, dirA);
    await register(a2, "a2-local-agent");
    const b1 = await machineStore(hub.url, freshPort(), dirB);
    a1.addTrustedGatewayPrincipal(principalOf(b1));
    b1.addTrustedGatewayPrincipal(principalOf(a1));

    await waitFor("b1 to see a2", async () => {
      const agents = await b1.listAgents(b1.peerId);
      return agents.some((agent) => agent.id === a2.peerId);
    });

    expect(b1.listVerifiedMembers()).toContainEqual({
      device: a2.peerId,
      principal: principalOf(a1),
    });
  });

  it("keeps merging, and still honours the valid principal, when another trusted principal id is malformed", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);
    const dirA = userDir();
    const dirB = userDir();

    const a1 = await machineStore(hub.url, freshPort(), dirA);
    const a2 = await machineStore(hub.url, a1.coordinatorPort, dirA);
    await register(a2, "a2-local-agent");
    const b1 = await machineStore(hub.url, freshPort(), dirB);
    a1.addTrustedGatewayPrincipal(principalOf(b1));
    // A typo ahead of the real principal: it must neither stop the hub directory merge nor block the principal after it.
    b1.addTrustedGatewayPrincipal("not-a-device-id");
    b1.addTrustedGatewayPrincipal(principalOf(a1));

    await waitFor("b1 to see a2 despite the malformed principal", async () => {
      const agents = await b1.listAgents(b1.peerId);
      return agents.some((agent) => agent.id === a2.peerId);
    });
  });
});

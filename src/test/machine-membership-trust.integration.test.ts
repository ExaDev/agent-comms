/**
 * Integration tests for machine identity (agent-comms#343): every bridge on a host is vouched for by that host's machine key, so list_agents groups devices by machine, whoami names the machine, and another machine that trusts this one reaches all of its devices until it untrusts the machine, which revokes the whole host in one act. Two hosts meet through a real hub; the stores of one host share its machine and user identity directories.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { MeshStore } from "../core/mesh-store.js";
import { CommsTool } from "../core/tool.js";
import { freeLocalPort, realHubOverWs, TeardownStack } from "./hub-helpers.js";
import { wireTestTransport } from "./test-transport.js";

/** Short enough that a gossip re-advertisement fires within a test's own poll budget. */
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

const cleanups = new TeardownStack();
const dirs: string[] = [];

afterEach(async () => {
  await cleanups.run();
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** One host's identity directory: its machine key and its account's user key live here, as they do in ~/.agent-comms. */
function hostDir(): string {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "machine-trust-host-"));
  dirs.push(dir);
  return dir;
}

async function hostStore(
  hubUrl: string,
  coordinatorPort: number,
  dir: string,
): Promise<MeshStore> {
  const store = new MeshStore({ coordinatorPort, hubUrl });
  await wireTestTransport(store, {
    presenceReadvertiseIntervalMs: FAST_GOSSIP_INTERVAL_MS,
    userIdentityOptions: { dir },
    machineIdentityOptions: { dir },
  });
  await store.init();
  cleanups.push(async () => store.shutdown());
  return store;
}

function machineOf(store: MeshStore): string {
  const machine = store.getMachineId();
  if (machine === undefined) throw new Error("store has no identity yet");
  return machine;
}

async function register(store: MeshStore, name: string): Promise<string> {
  const agent = await store.registerAgent({
    name,
    harness: "test",
    cwd: `/test/${name}`,
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  return agent.id;
}

async function listAgentsText(store: MeshStore): Promise<string> {
  const result = await new CommsTool(store).handle(
    { agentId: store.peerId, harness: "test", cwd: "/test", pid: process.pid },
    { action: "list_agents" },
  );
  expect(result.isError, result.content).toBe(false);
  return result.content;
}

/** The rows list_agents prints under the given machine heading, up to the next heading. */
function rowsUnder(listing: string, heading: string): string {
  const start = listing.indexOf(heading);
  if (start === -1) return "";
  const rest = listing.slice(start + heading.length);
  const next = rest.search(/\n {2}Machine /);
  return next === -1 ? rest : rest.slice(0, next);
}

describe("machine identity", () => {
  it("gives every store on a host the same machine, named by whoami, and groups local agents under this machine", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);
    const dir = hostDir();
    const a1 = await hostStore(hub.url, await freeLocalPort(), dir);
    const a2 = await hostStore(hub.url, a1.coordinatorPort, dir);
    await register(a1, "a1-agent");
    await register(a2, "a2-agent");

    expect(machineOf(a1)).toBe(machineOf(a2));
    expect(machineOf(a1)).not.toBe(a1.getUserPrincipalId());
    const whoami = await new CommsTool(a1).handle(
      { agentId: a1.peerId, harness: "test", cwd: "/test", pid: process.pid },
      { action: "whoami" },
    );
    expect(whoami.content).toContain(`Machine: ${machineOf(a1)}`);

    const heading = `Machine ${machineOf(a1)} (this machine):`;
    await waitFor("a1 to place a2 on this machine", async () =>
      rowsUnder(await listAgentsText(a1), heading).includes(a2.peerId),
    );
    expect(rowsUnder(await listAgentsText(a1), heading)).toContain(a1.peerId);
  });

  it("reaches every device of a trusted remote machine, grouped under it, and revokes the whole host when the machine is untrusted", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);
    const dirA = hostDir();
    const dirB = hostDir();
    const a1 = await hostStore(hub.url, await freeLocalPort(), dirA);
    const a2 = await hostStore(hub.url, a1.coordinatorPort, dirA);
    const b1 = await hostStore(hub.url, await freeLocalPort(), dirB);
    await register(a1, "a1-agent");
    await register(a2, "a2-agent");
    await register(b1, "b1-agent");

    // Each host trusts only the other's machine: no device id and no principal is trusted anywhere.
    a1.addTrustedGatewayMachine(machineOf(b1));
    a2.addTrustedGatewayMachine(machineOf(b1));
    b1.addTrustedGatewayMachine(machineOf(a1));
    expect(b1.listTrustedGateways()).toEqual([]);
    expect(b1.listTrustedGatewayPrincipals()).toEqual([]);

    const remoteHeading = `Machine ${machineOf(a1)}:`;
    await waitFor(
      "b1 to list both of A's devices under A's machine",
      async () => {
        const rows = rowsUnder(await listAgentsText(b1), remoteHeading);
        return rows.includes(a1.peerId) && rows.includes(a2.peerId);
      },
    );
    expect(b1.listVerifiedMembers()).toEqual(
      expect.arrayContaining([
        { device: a1.peerId, kind: "machine", issuer: machineOf(a1) },
        { device: a2.peerId, kind: "machine", issuer: machineOf(a1) },
      ]),
    );
    expect(b1.gatewayTrust.isReachable(a2.peerId)).toBe(true);

    b1.removeTrustedGatewayMachine(machineOf(a1));

    expect(b1.gatewayTrust.isReachable(a1.peerId)).toBe(false);
    expect(b1.gatewayTrust.isReachable(a2.peerId)).toBe(false);
    expect(b1.listVerifiedMembers()).toEqual([]);
    const afterRevoke = await listAgentsText(b1);
    expect(afterRevoke).toContain(b1.peerId);
    expect(afterRevoke).not.toContain(a1.peerId);
    expect(afterRevoke).not.toContain(a2.peerId);
    expect(afterRevoke).not.toContain(remoteHeading);
  });

  it("carries the machine proof only in a visible agent's advert", async () => {
    const store = new MeshStore({ coordinatorPort: await freeLocalPort() });
    await wireTestTransport(store);
    await store.init();
    cleanups.push(async () => store.shutdown());
    const id = await register(store, "visible-then-hidden");

    await waitFor("the machine proof to be minted", async () => {
      await Promise.resolve();
      return store.selfAgentAdvert?.machine !== undefined;
    });
    await store.updateAgent(id, { visibility: "hidden" });

    expect(store.selfAgentAdvert).toBeUndefined();
  });
});

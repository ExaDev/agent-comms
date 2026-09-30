/**
 * Integration tests for naming (agent-comms#345): a machine's self display name, signed by its machine key, reaches a peer that trusts it and is shown as that machine's own claim; the viewer's petnames come first wherever an id is shown; and a petname never leaves the viewer's own storage, over the hub or over a direct peer session. Two hosts meet through a real hub; the stores of one host share its identity directory.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { MeshStore } from "../core/mesh-store.js";
import { CommsTool } from "../core/tool.js";
import { shortId } from "../core/display-name.js";
import type { CommsAction } from "../core/types.js";
import {
  freeLocalPort,
  observeHub,
  realHubOverWs,
  TeardownStack,
} from "./hub-helpers.js";
import { waitFor, wireTestTransportWithHub } from "./test-transport.js";
import type { WireMeshTransport } from "../core/wire-mesh-transport.js";

/** A device-id is a 64-character lowercase hex SHA-256 digest. */
const DEVICE_ID_HEX_LENGTH = 64;
/** Short enough that a gossip re-advertisement fires within a test's own poll budget. */
const FAST_GOSSIP_INTERVAL_MS = 50;
/** How long a petname is watched for on the wire: many gossip rounds. */
const WIRE_WATCH_MS = 1500;

const sleep = async (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const cleanups = new TeardownStack();
const dirs: string[] = [];

afterEach(async () => {
  await cleanups.run();
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function hostDir(): string {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "naming-host-"));
  dirs.push(dir);
  return dir;
}

interface Host {
  store: MeshStore;
  transport: WireMeshTransport;
  tool: CommsTool;
}

async function hostStore(
  hubUrl: string,
  coordinatorPort: number,
  dir: string,
): Promise<Host> {
  const store = new MeshStore({
    coordinatorPort,
    hubUrl,
    slot: { harness: "test", cwd: `/naming/${String(coordinatorPort)}`, dir },
  });
  const { transport } = await wireTestTransportWithHub(store, {
    presenceReadvertiseIntervalMs: FAST_GOSSIP_INTERVAL_MS,
    userIdentityOptions: { dir },
    machineIdentityOptions: { dir },
  });
  await store.init();
  cleanups.push(async () => store.shutdown());
  await store.registerAgent({
    name: `agent-${String(coordinatorPort)}`,
    harness: "test",
    cwd: "/test",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  return {
    store,
    transport,
    tool: new CommsTool(store, { naming: store.naming }),
  };
}

function machineOf(host: Host): string {
  const machine = host.store.getMachineId();
  if (machine === undefined) throw new Error("store has no identity yet");
  return machine;
}

async function run(host: Host, action: CommsAction): Promise<string> {
  const result = await host.tool.handle(
    {
      agentId: host.store.peerId,
      harness: "test",
      cwd: "/test",
      pid: process.pid,
    },
    action,
  );
  expect(result.isError, result.content).toBe(false);
  return result.content;
}

/** How many layers of base64 wrapping wireText looks through: a proof is base64url text of JSON holding base64 fields, so two layers reach its innermost strings, and one more is margin. */
const ENCODING_DEPTH = 3;

/** s and every readable string base64 decoding reveals beneath it, to ENCODING_DEPTH layers. */
function decodings(s: string, depth: number): string[] {
  if (depth === 0) return [s];
  const decoded = Buffer.from(s, "base64").toString("utf-8");
  const inner = [...decoded.matchAll(/[A-Za-z0-9+/_=-]{8,}/g)].map(
    (match) => match[0],
  );
  return [s, decoded, ...inner.flatMap((part) => decodings(part, depth - 1))];
}

/** Everything the given adverts carry, as one string, with every base64-wrapped layer decoded alongside, so a test can search every field, including the text inside a signed proof or claim, at once. */
function wireText(adverts: readonly unknown[]): string {
  const strings: string[] = [];
  JSON.stringify(adverts, (_key, value: unknown) => {
    if (typeof value === "string")
      strings.push(...decodings(value, ENCODING_DEPTH));
    return value instanceof Uint8Array ? Array.from(value) : value;
  });
  return strings.join("\n");
}

describe("naming", () => {
  it("shows a trusted machine's own name, and the viewer's petnames before it, in list_agents, gateway_list_trusted and whoami", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);
    const a = await hostStore(hub.url, await freeLocalPort(), hostDir());
    const b = await hostStore(hub.url, await freeLocalPort(), hostDir());
    a.store.addTrustedGatewayMachine(machineOf(b));
    b.store.addTrustedGatewayMachine(machineOf(a));

    await run(a, { action: "machine_name", name: "host-a" });
    const machineA = machineOf(a);
    await waitFor(
      async () =>
        (await run(b, { action: "list_agents" })).includes(
          `Machine "host-a" ${shortId(machineA)}:`,
        ),
      "b to show A's machine under the name A signed",
    );

    await run(b, {
      action: "petname_set",
      device: machineA,
      name: "alpha box",
    });
    await run(b, {
      action: "petname_set",
      device: a.store.peerId,
      name: "a's agent",
    });

    const listing = await run(b, { action: "list_agents" });
    expect(listing).toContain(
      `Machine alpha box "host-a" ${shortId(machineA)}:`,
    );
    const agentName = (await a.store.getAgent(a.store.peerId))?.name;
    expect(listing).toContain(
      `a's agent "${String(agentName)}" ${shortId(a.store.peerId)}`,
    );
    expect(await run(b, { action: "gateway_list_trusted" })).toContain(
      `${machineA}  alpha box "host-a" ${shortId(machineA)}`,
    );
    expect(await run(a, { action: "whoami" })).toContain(
      `Machine name: "host-a" ${shortId(machineA)}`,
    );
  });

  it("puts the machine's own name on the wire but never a petname, over the hub or a direct peer session", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);
    const observer = await observeHub(hub.url);
    cleanups.push(observer.close);
    const dir = hostDir();
    const a1 = await hostStore(hub.url, await freeLocalPort(), dir);
    const a2 = await hostStore(hub.url, a1.store.coordinatorPort, dir);
    // Trusting any machine is what lets a1 advertise itself on the hub at all.
    a1.store.addTrustedGatewayMachine("a".repeat(DEVICE_ID_HEX_LENGTH));

    const selfName = "self-name-on-the-wire";
    const petname = "petname-never-on-the-wire";
    await run(a1, {
      action: "petname_set",
      device: a2.store.peerId,
      name: petname,
    });
    await run(a1, {
      action: "petname_set",
      device: machineOf(a1),
      name: petname,
    });
    await run(a1, { action: "machine_name", name: selfName });

    await waitFor(
      () => wireText(observer.advertsFor(a1.store.peerId)).includes(selfName),
      "the hub to carry a1's machine name",
    );
    await waitFor(
      () =>
        wireText(
          a2.transport
            .listKnownDevices()
            .filter(({ deviceId }) => deviceId === a1.store.peerId),
        ).includes(selfName),
      "a2 to receive a1's machine name over their direct session",
    );
    await sleep(WIRE_WATCH_MS);

    expect(wireText(observer.adverts())).not.toContain(petname);
    expect(wireText(a2.transport.listKnownDevices())).not.toContain(petname);
    expect(await run(a1, { action: "petname_list" })).toContain(petname);
  });
});

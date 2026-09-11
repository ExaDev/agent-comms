/**
 * Integration test for issue #23: state patches broadcast before the mesh data connections are established must not be silently lost.
 *
 * Every production bridge calls registerAgent() immediately after store.init() returns, while the fire-and-forget peer dials are still in flight. Broadcasts landing in that window used to have nowhere to go, so the joining peer stayed invisible in established peers' list_agents until some later patch happened to arrive. The transport now queues broadcasts for dialling peers and flushes them when the connection registers.
 */

import * as assert from "node:assert/strict";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { MeshStore } from "../core/mesh-store.js";
import { WireMeshTransport } from "../core/wire-mesh-transport.js";
import { generateIdentity } from "../core/identity.js";
import type { PeerIdentity } from "../core/identity.js";

const TEST_PORT = 19890;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A peer wired like a real bridge: WireMeshTransport, device-id peer ID. */
function makePeer(identity: PeerIdentity): MeshStore {
  const store = new MeshStore(TEST_PORT);
  store.peerId = deviceIdToHex(Uint8Array.from(identity.deviceId));
  store.setTransport(new WireMeshTransport(store.events, identity));
  return store;
}

/** Poll until the predicate holds, or fail with the message. */
async function waitFor(
  what: string,
  check: () => Promise<boolean>,
): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (await check()) return;
    await sleep(100);
  }
  assert.ok(false, `timed out waiting for ${what}`);
}

async function main(): Promise<void> {
  // A is the coordinator and stays up throughout.
  const a = makePeer(generateIdentity());
  await a.init();
  await a.registerAgent({
    name: "peer-a",
    harness: "claude-code",
    cwd: "/test/a",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });

  // B joins and registers IMMEDIATELY after init() — no settle delay. This is exactly the production bridge pattern that used to race the dials.
  const b = makePeer(generateIdentity());
  await b.init();
  await b.registerAgent({
    name: "peer-b",
    harness: "pi",
    cwd: "/test/b",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  const bId = b.peerId;

  await waitFor(
    "the coordinator to see the immediately-registered agent",
    async () => {
      const agents = await a.listAgents(a.peerId);
      const seen = agents.find((agent) => agent.id === bId);
      return seen?.status === "active";
    },
  );

  await waitFor("the joining peer to see the coordinator's agent", async () => {
    const agents = await b.listAgents(b.peerId);
    return agents.some((agent) => agent.id === a.peerId);
  });

  await b.shutdown();
  await a.shutdown();
  console.log("✓ immediate registration is visible without settle delays");
}

main().catch((err: unknown) => {
  console.error("Test failed:", err);
  process.exitCode = 1;
  // The sequence above keeps mesh handles open when it fails partway; exit explicitly so a failure cannot hang the runner.
  process.exit(1);
});

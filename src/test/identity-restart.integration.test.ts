/**
 * Integration test for issue #14: a bridge restarted with a persisted identity must keep its agent ID, room membership, and push delivery.
 *
 * Before persistent identities, every restart generated a fresh TLS certificate, so the fingerprint-derived agent ID changed and peers kept targeting the old ID: their messages queued for an agent whose local handler (gated on agentId === peerId) never fired again.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MeshStore } from "../core/mesh-store.js";
import { TlsTransport } from "../core/tls-transport.js";
import { generateIdentity } from "../core/identity.js";
import type { PeerIdentity } from "../core/identity.js";
import {
  loadOrCreateIdentity,
  releaseIdentityLock,
  type IdentitySlot,
} from "../core/identity-store.js";
import type { DeliveryEvent } from "../core/types.js";

const TEST_PORT = 19889;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Peer {
  store: MeshStore;
  deliveries: DeliveryEvent[];
}

/** A peer wired like a real bridge: TLS transport, fingerprint peer ID. */
function makePeer(identity: PeerIdentity): Peer {
  const store = new MeshStore(TEST_PORT);
  store.peerId = identity.fingerprint;
  store.setTransport(new TlsTransport(store.events, identity));
  const deliveries: DeliveryEvent[] = [];
  return { store, deliveries };
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
  const dir = fs.mkdtempSync(path.join(tmpdir(), "agent-comms-restart-test-"));
  const slot: IdentitySlot = { harness: "pi", cwd: "/tmp/project", dir };

  // Peer B is a normal ephemeral bridge that stays up throughout.
  const b = makePeer(generateIdentity());
  await b.store.init();
  await b.store.registerAgent({
    name: "peer-b",
    harness: "claude-code",
    cwd: "/tmp/b",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  b.store.onDelivery = (_id, ev) => {
    b.deliveries.push(ev);
  };
  await sleep(200);

  // First lifecycle of peer A: persistent identity, registers and creates a room.
  const identityA = loadOrCreateIdentity(slot);
  const a1 = makePeer(identityA);
  await a1.store.init();
  await a1.store.registerAgent({
    name: "peer-a",
    harness: "pi",
    cwd: "/tmp/project",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  const roomId = "restart-continuity";
  await a1.store.createRoom({
    name: roomId,
    type: "public",
    owner: a1.store.peerId,
    description: "issue 14 acceptance",
  });
  await sleep(200);
  await b.store.joinRoom(roomId, b.store.peerId);
  await sleep(200);
  const agentIdA = a1.store.peerId;

  // A goes away without marking its agent offline (crash simulation).
  await a1.store.shutdown();
  await sleep(200);

  // A restarts in the same slot: same key material, same agent ID.
  const identityA2 = loadOrCreateIdentity(slot);
  assert.equal(identityA2.fingerprint, identityA.fingerprint);
  const a2 = makePeer(identityA2);
  a2.store.onDelivery = (_id, ev) => {
    a2.deliveries.push(ev);
  };
  await a2.store.init();
  await a2.store.registerAgent({
    name: "peer-a",
    harness: "pi",
    cwd: "/tmp/project",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });

  assert.equal(a2.store.peerId, agentIdA);
  await waitFor("B to see the restarted agent active", async () => {
    const agents = await b.store.listAgents(b.store.peerId);
    const seen = agents.find((agent) => agent.id === agentIdA);
    return seen?.status === "active";
  });

  // Room membership survived: B's message must push to restarted A.
  await b.store.sendRoomMessage(roomId, b.store.peerId, "after restart");
  await waitFor("the room message to push to restarted A", async () =>
    a2.deliveries.some(
      (ev) =>
        ev.type === "room_message" && ev.message.content === "after restart",
    ),
  );

  // DMs targeted at the persisted ID must deliver too.
  await b.store.sendDm(b.store.peerId, agentIdA, "dm after restart");
  await waitFor("the DM to push to restarted A", async () =>
    a2.deliveries.some(
      (ev) => ev.type === "dm" && ev.message.content === "dm after restart",
    ),
  );

  await a2.store.shutdown();
  await b.store.shutdown();
  releaseIdentityLock(slot);
  console.log(
    "✓ restart continuity holds: same ID, active, room + DM delivered",
  );
}

main().catch((err: unknown) => {
  console.error("Test failed:", err);
  process.exitCode = 1;
  // The sequence above keeps mesh handles open when it fails partway; exit explicitly so a failure cannot hang the runner.
  process.exit(1);
});

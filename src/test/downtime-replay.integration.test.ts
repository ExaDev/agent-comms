/**
 * Integration test for issue #28: a bridge restarted with a persisted identity must be push-delivered the events that accumulated while its process was down, not just find them in synced history.
 *
 * Peer B goes away; A sends a room message while B is down; B restarts in the same identity slot and must fire onDelivery for the missed message.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MeshStore } from "../core/mesh-store.js";
import { TlsTransport } from "../core/tls-transport.js";
import { generateIdentity } from "../core/identity.js";
import {
  loadOrCreateIdentity,
  releaseIdentityLock,
  type IdentitySlot,
} from "../core/identity-store.js";
import type { DeliveryEvent } from "../core/types.js";
import type { PeerIdentity } from "../core/identity.js";

const TEST_PORT = 19896;
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
  const dir = fs.mkdtempSync(path.join(tmpdir(), "agent-comms-downtime-"));
  const slot: IdentitySlot = { harness: "pi", cwd: "/tmp/project", dir };

  // A is a normal ephemeral bridge that stays up throughout.
  const a = makePeer(generateIdentity());
  await a.store.init();
  await a.store.registerAgent({
    name: "peer-a",
    harness: "claude-code",
    cwd: "/tmp/a",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  await a.store.createRoom({
    name: "downtime",
    type: "public",
    owner: a.store.peerId,
    description: "issue 28 acceptance",
  });
  await sleep(200);

  // B joins with a persisted identity and becomes a room member.
  const identityB = loadOrCreateIdentity(slot);
  const b1 = makePeer(identityB);
  await b1.store.init();
  // Registration must wait for the TLS data connections to establish (#23).
  await sleep(300);
  await b1.store.registerAgent({
    name: "peer-b",
    harness: "pi",
    cwd: "/tmp/project",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  await waitFor("the room to reach the joiner", async () => {
    const rooms = await b1.store.listRooms(b1.store.peerId);
    return rooms.some((room) => room.id === "downtime");
  });
  await b1.store.joinRoom("downtime", b1.store.peerId);
  await waitFor("membership to reach the sender", async () => {
    const room = await a.store.getRoom("downtime");
    return room?.members.includes(b1.store.peerId) === true;
  });

  // B goes down.
  await b1.store.shutdown();
  await sleep(200);

  // A sends a room message while B is down.
  await a.store.sendRoomMessage(
    "downtime",
    a.store.peerId,
    "while you were down",
  );
  await sleep(200);

  // B restarts in the same slot: same identity, same agent ID.
  const identityB2 = loadOrCreateIdentity(slot);
  assert.equal(identityB2.fingerprint, identityB.fingerprint);
  const b2 = makePeer(identityB2);
  b2.store.onDelivery = (_id, ev) => {
    b2.deliveries.push(ev);
  };
  await b2.store.init();
  await b2.store.registerAgent({
    name: "peer-b",
    harness: "pi",
    cwd: "/tmp/project",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });

  // The message sent during downtime must push to the restarted bridge.
  await waitFor(
    "the downtime message to push to the restarted bridge",
    async () =>
      b2.deliveries.some(
        (ev) =>
          ev.type === "room_message" &&
          ev.message.content === "while you were down",
      ),
  );

  await b2.store.shutdown();
  await a.store.shutdown();
  releaseIdentityLock(slot);
  console.log("✓ downtime messages push-deliver on restart");
}

main().catch((err: unknown) => {
  console.error("Test failed:", err);
  process.exitCode = 1;
  // The sequence above keeps mesh handles open when it fails partway; exit explicitly so a failure cannot hang the runner.
  process.exit(1);
});

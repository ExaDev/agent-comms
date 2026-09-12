/**
 * Integration test for issue #28: a bridge restarted with a persisted identity must be push-delivered the events that accumulated while its process was down, not just find them in synced history.
 *
 * Peer B goes away; A sends a room message while B is down; B restarts in the same identity slot and must fire onDelivery for the missed message.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { createSystemClock } from "wire-mesh-core/adapters/system-clock";
import { MeshStore } from "../core/mesh-store.js";
import { WireMeshTransport } from "../core/wire-mesh-transport.js";
import {
  loadOrCreateIdentity,
  releaseIdentityLock,
  type IdentitySlot,
} from "../core/identity-store.js";
import { toIdentityPort } from "../core/wire-mesh-identity.js";
import type { DeliveryEvent } from "../core/types.js";
import type { PeerIdentity } from "../core/identity.js";
import { ownerNamedRoomPath } from "../core/room-path.js";

const TEST_PORT = 19896;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Peer {
  store: MeshStore;
  deliveries: DeliveryEvent[];
}

/** A peer wired like a real bridge: WireMeshTransport, device-id peer ID, and a persisted identity slot so createRoom can mint and persist the owner's own room:member grant. */
async function makePeer(
  identity: PeerIdentity,
  slot: IdentitySlot,
): Promise<Peer> {
  const store = new MeshStore(TEST_PORT);
  store.peerId = deviceIdToHex(Uint8Array.from(identity.deviceId));
  store.setTransport(new WireMeshTransport(store.events, identity));
  store.setIdentity({
    identity: await toIdentityPort(identity),
    clock: createSystemClock(),
    slot,
  });
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
  const slotA: IdentitySlot = {
    harness: "claude-code",
    cwd: "/tmp/a",
    dir: fs.mkdtempSync(path.join(tmpdir(), "agent-comms-downtime-a-")),
  };

  // A is a normal ephemeral bridge that stays up throughout.
  const a = await makePeer(loadOrCreateIdentity(slotA), slotA);
  await a.store.init();
  await a.store.registerAgent({
    name: "peer-a",
    harness: "claude-code",
    cwd: "/tmp/a",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  const roomId = ownerNamedRoomPath(a.store.peerId, "downtime");
  await a.store.createRoom({
    name: "downtime",
    type: "public",
    owner: a.store.peerId,
    description: "issue 28 acceptance",
  });
  await sleep(200);

  // B joins with a persisted identity and becomes a room member.
  const identityB = loadOrCreateIdentity(slot);
  const b1 = await makePeer(identityB, slot);
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
    return rooms.some((room) => room.id === roomId);
  });
  await b1.store.joinRoom(roomId, b1.store.peerId);
  await waitFor("membership to reach the sender", async () => {
    const room = await a.store.getRoom(roomId);
    return room?.members.includes(b1.store.peerId) === true;
  });

  // B goes down.
  await b1.store.shutdown();
  await sleep(200);

  // A sends a room message while B is down.
  await a.store.sendRoomMessage(roomId, a.store.peerId, "while you were down");
  await sleep(200);

  // B restarts in the same slot: same identity, same agent ID.
  const identityB2 = loadOrCreateIdentity(slot);
  assert.equal(
    deviceIdToHex(Uint8Array.from(identityB2.deviceId)),
    deviceIdToHex(Uint8Array.from(identityB.deviceId)),
  );
  const b2 = await makePeer(identityB2, slot);
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

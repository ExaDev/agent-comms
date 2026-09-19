/**
 * Integration test for issue #14: a bridge restarted with a persisted identity must keep its agent ID, room membership, and push delivery.
 *
 * Before persistent identities, every restart generated a fresh keypair, so the device-id-derived agent ID changed and peers kept targeting the old ID: their messages queued for an agent whose local handler (gated on agentId === peerId) never fired again.
 */

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect } from "vitest";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { createSystemClock } from "wire-mesh-core/adapters/system-clock";
import { createRevocationView } from "wire-mesh-core/domain/revocation-view";
import { createMemoryStorage } from "wire-mesh-core/adapters/memory-storage";
import { MeshStore } from "../core/mesh-store.js";
import { WireMeshTransport } from "../core/wire-mesh-transport.js";
import type { PeerIdentity } from "../core/identity.js";
import {
  loadOrCreateIdentity,
  releaseIdentityLock,
  type IdentitySlot,
} from "../core/identity-store.js";
import { toIdentityPort } from "../core/wire-mesh-identity.js";
import { loadOrCreateUserIdentity } from "../core/user-identity.js";
import type { DeliveryEvent } from "../core/types.js";
import { ownerNamedRoomPath } from "../core/room-path.js";

const TEST_PORT = 19889;
/** Attempts {@link waitFor} polls before giving up. */
const MAX_WAIT_ATTEMPTS = 20;
/** Delay between {@link waitFor} poll attempts, in milliseconds. */
const WAIT_POLL_INTERVAL_MS = 100;
/** Delay allowing mesh state to settle across peers before the next step, in milliseconds. */
const SETTLE_DELAY_MS = 200;
const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

interface Peer {
  store: MeshStore;
  deliveries: DeliveryEvent[];
}

/** A peer wired like a real bridge: WireMeshTransport, device-id peer ID, and a persisted identity slot so createRoom can mint and persist the owner's own room:member grant. */
async function makePeer(
  identity: PeerIdentity,
  slot: Readonly<IdentitySlot>,
): Promise<Peer> {
  const store = new MeshStore({ coordinatorPort: TEST_PORT });
  store.peerId = deviceIdToHex(Uint8Array.from(identity.deviceId));
  store.setTransport(
    new WireMeshTransport(store.events, identity, {
      roomVerbHandlers: store.roomVerbHandlers,
    }),
  );
  const userIdentityOptions = {
    dir: fs.mkdtempSync(path.join(tmpdir(), "agent-comms-test-user-identity-")),
  };
  store.setIdentity({
    identity: await toIdentityPort(identity),
    clock: createSystemClock(),
    slot,
    revocation: createRevocationView(),
    dataStorage: createMemoryStorage(),
    userIdentity: await toIdentityPort(
      loadOrCreateUserIdentity(userIdentityOptions),
    ),
    userIdentityOptions,
  });
  const deliveries: DeliveryEvent[] = [];
  return { store, deliveries };
}

/** Poll until the predicate holds, or fail with the message. */
async function waitFor(
  what: string,
  check: () => Promise<boolean>,
): Promise<void> {
  for (let i = 0; i < MAX_WAIT_ATTEMPTS; i++) {
    if (await check()) return;
    await sleep(WAIT_POLL_INTERVAL_MS);
  }
  expect(false, `timed out waiting for ${what}`).toBeTruthy();
}

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "agent-comms-restart-test-"));
  const slot: IdentitySlot = { harness: "pi", cwd: "/tmp/project", dir };
  const slotB: IdentitySlot = {
    harness: "claude-code",
    cwd: "/tmp/b",
    dir: fs.mkdtempSync(path.join(tmpdir(), "agent-comms-restart-test-b-")),
  };

  // Peer B is a normal ephemeral bridge that stays up throughout.
  const b = await makePeer(loadOrCreateIdentity(slotB), slotB);
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
  await sleep(SETTLE_DELAY_MS);

  // First lifecycle of peer A: persistent identity, registers and creates a room.
  const identityA = loadOrCreateIdentity(slot);
  const a1 = await makePeer(identityA, slot);
  await a1.store.init();
  await a1.store.registerAgent({
    name: "peer-a",
    harness: "pi",
    cwd: "/tmp/project",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  const roomId = ownerNamedRoomPath(a1.store.peerId, "restart-continuity");
  await a1.store.createRoom({
    name: "restart-continuity",
    type: "public",
    owner: a1.store.peerId,
    description: "issue 14 acceptance",
  });
  await sleep(SETTLE_DELAY_MS);
  // The room already replicated to B via legacy full-state-sync, but knowing about a room is not the same as holding a room:member token for it -- B's own join still goes through real wire-level admission, held open until A approves it.
  const joinPromise = b.store.joinRoom(roomId, b.store.peerId);
  await waitFor("A to see B's pending join request", async () =>
    Promise.resolve(
      a1.store
        .listPendingRoomJoins()
        .some((p) => p.roomPath === roomId && p.requesterId === b.store.peerId),
    ),
  );
  a1.store.acceptRoomJoin(roomId, b.store.peerId);
  await joinPromise;
  await sleep(SETTLE_DELAY_MS);
  const agentIdA = a1.store.peerId;

  // A goes away without marking its agent offline (crash simulation).
  await a1.store.shutdown();
  await sleep(SETTLE_DELAY_MS);

  // A restarts in the same slot: same key material, same agent ID.
  const identityA2 = loadOrCreateIdentity(slot);
  expect(deviceIdToHex(Uint8Array.from(identityA2.deviceId))).toBe(
    deviceIdToHex(Uint8Array.from(identityA.deviceId)),
  );
  const a2 = await makePeer(identityA2, slot);
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

  expect(a2.store.peerId).toBe(agentIdA);
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

  // DMs targeted at the persisted ID must deliver too -- the two-round consent flow first.
  const dmAccessPromise = b.store.requestDmAccess(agentIdA);
  await waitFor("restarted A to see B's pending DM request", async () =>
    Promise.resolve(
      a2.store
        .listPendingRoomJoins()
        .some((p) => p.requesterId === b.store.peerId),
    ),
  );
  const pendingDm = a2.store
    .listPendingRoomJoins()
    .find((p) => p.requesterId === b.store.peerId);
  expect(pendingDm).toBeTruthy();
  if (pendingDm === undefined) throw new Error("expected a pending DM request");
  a2.store.acceptRoomJoin(pendingDm.roomPath, b.store.peerId);
  await dmAccessPromise;

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

test("a bridge restarted with a persisted identity keeps its agent ID, room membership, and push delivery", async () => {
  await main();
});

/**
 * Unit tests for the directed room.send fan-out's own retry queue (P3.5): a send that fails because its target member isn't currently reachable is queued rather than thrown or dropped, and retried the moment that member's connection is (re)established -- handlePeerConnected fires for exactly that event, so these tests trigger it directly via store.events.onPeerConnected rather than driving a real second peer (see room-send-retry.integration.test.ts for the real, two-peer version of this same acceptance behaviour).
 */

import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { ManageOutcome } from "wire-mesh-core/domain/mesh-session";
import { MeshStore } from "../core/mesh-store.js";
import type { MeshTransport } from "../core/transport.js";
import { deleteRoomToken } from "../core/identity-store.js";
import { waitFor, wireTestTransport } from "./test-transport.js";

const MEMBER_ID = "b".repeat(64);
const QUEUE_CAP = 100;

/** A MeshTransport whose sendRoomRequest always fails until told otherwise -- flippable mid-test to simulate the member becoming reachable, and recording every attempt made against it (including retries) so a test can assert exactly which sends were retried. */
function fakeTransport(): {
  transport: MeshTransport;
  attempts: unknown[];
  setConnected: (connected: boolean) => void;
} {
  let connected = false;
  const attempts: unknown[] = [];
  const transport: MeshTransport = {
    dataPort: 0,
    isCoordinator: false,
    hasCoordinatorConnection: false,
    startDataServer: async () => {},
    connectToCoordinator: async () => {},
    becomeCoordinator: async () => {},
    connectToPeer: async () => {},
    send: async () => {},
    acceptConnection: async () => {},
    rejectConnection: async () => {},
    connectToRemote: async () => {},
    broadcast: async () => {},
    broadcastRevocation: async () => {},
    sendRoomRequest: async (_memberId, command): Promise<ManageOutcome> => {
      attempts.push(command.params);
      if (!connected) {
        return { result: "error", code: "not_connected" };
      }
      return { result: "ok" };
    },
    addListener: async () => "id",
    removeListener: async () => {},
    listListeners: () => [],
    shutdown: async () => {},
    unref: () => {},
  };
  return {
    transport,
    attempts,
    setConnected: (value: boolean) => {
      connected = value;
    },
  };
}

void test("a room.send to an unreachable member is queued and retried once it reconnects", async () => {
  const store = new MeshStore();
  await wireTestTransport(store);
  const owner = await store.registerAgent({
    name: "owner",
    harness: "pi",
    cwd: "/tmp/p",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  const room = await store.createRoom({
    name: "general",
    type: "public",
    owner: owner.id,
    description: "",
  });

  await store.joinRoom(room.id, MEMBER_ID);
  const { transport, attempts, setConnected } = fakeTransport();
  store.setTransport(transport);

  await store.sendRoomMessage(room.id, owner.id, "hello");
  assert.equal(attempts.length, 1, "the first, failed attempt was made");

  setConnected(true);
  store.events.onPeerConnected(
    { id: MEMBER_ID },
    { id: MEMBER_ID, port: 0, startedAt: new Date().toISOString() },
  );

  await waitFor(
    () => attempts.length === 2,
    "the queued send to retry once the member reconnects",
  );
});

void test("the retry queue is bounded oldest-first per member", async () => {
  const store = new MeshStore();
  await wireTestTransport(store);
  const owner = await store.registerAgent({
    name: "owner",
    harness: "pi",
    cwd: "/tmp/p",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  const room = await store.createRoom({
    name: "general",
    type: "public",
    owner: owner.id,
    description: "",
  });

  await store.joinRoom(room.id, MEMBER_ID);
  const { transport, attempts, setConnected } = fakeTransport();
  store.setTransport(transport);

  const overflow = 20;
  for (let i = 0; i < QUEUE_CAP + overflow; i++) {
    await store.sendRoomMessage(room.id, owner.id, `msg-${String(i)}`);
  }
  assert.equal(attempts.length, QUEUE_CAP + overflow);

  attempts.length = 0;
  setConnected(true);
  store.events.onPeerConnected(
    { id: MEMBER_ID },
    { id: MEMBER_ID, port: 0, startedAt: new Date().toISOString() },
  );

  await waitFor(
    () => attempts.length === QUEUE_CAP,
    "exactly the cap's worth of retries to fire",
  );

  function textOf(params: unknown): string | undefined {
    if (typeof params !== "object" || params === null) return undefined;
    if (!("text" in params)) return undefined;
    return typeof params.text === "string" ? params.text : undefined;
  }
  assert.equal(textOf(attempts[0]), `msg-${String(overflow)}`);
  assert.equal(
    textOf(attempts[attempts.length - 1]),
    `msg-${String(QUEUE_CAP + overflow - 1)}`,
  );
});

void test("a flush drops (not re-queues) a send whose room this store no longer holds a token for", async () => {
  const store = new MeshStore();
  const slot = await wireTestTransport(store);
  const owner = await store.registerAgent({
    name: "owner",
    harness: "pi",
    cwd: "/tmp/p",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  const room = await store.createRoom({
    name: "general",
    type: "public",
    owner: owner.id,
    description: "",
  });

  await store.joinRoom(room.id, MEMBER_ID);
  const { transport, attempts } = fakeTransport();
  store.setTransport(transport);

  await store.sendRoomMessage(room.id, owner.id, "hello");
  assert.equal(attempts.length, 1);

  deleteRoomToken(slot, room.id);

  store.events.onPeerConnected(
    { id: MEMBER_ID },
    { id: MEMBER_ID, port: 0, startedAt: new Date().toISOString() },
  );
  // No token to present -- give the flush a moment to run, then confirm it made no further attempt.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(attempts.length, 1);
});

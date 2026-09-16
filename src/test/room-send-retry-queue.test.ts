/**
 * Unit tests for the directed room.send fan-out's own retry queue (P3.5): a send that fails because its target member isn't currently reachable is queued rather than thrown or dropped, and retried the moment that member's connection is (re)established -- handlePeerConnected fires for exactly that event, so these tests trigger it directly via store.events.onPeerConnected rather than driving a real second peer (see room-send-retry.integration.test.ts for the real, two-peer version of this same acceptance behaviour).
 */

import { test, expect } from "vitest";
import type { ManageOutcome } from "wire-mesh-core/domain/mesh-session";
import { MeshStore } from "../core/mesh-store.js";
import type { MeshTransport } from "../core/transport.js";
import { deleteRoomToken } from "../core/identity-store.js";
import { waitFor, wireTestTransport } from "./test-transport.js";

const DEVICE_ID_HEX_LENGTH = 64;
const MEMBER_ID = "b".repeat(DEVICE_ID_HEX_LENGTH);
const QUEUE_CAP = 100;

/** Extracts a room.send request's own text field from a recorded attempt's params -- distinguishes an actual room.send retry from any other room-domain request (e.g. a room.notify) that might also be queued and replayed against the same member. */
function textOf(params: unknown): string | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  if (!("text" in params)) return undefined;
  return typeof params.text === "string" ? params.text : undefined;
}

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

test("a room.send to an unreachable member is queued and retried once it reconnects", async () => {
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
  expect(attempts.length, "the first, failed attempt was made").toBe(1);

  setConnected(true);
  store.events.onPeerConnected(
    { id: MEMBER_ID },
    { id: MEMBER_ID, port: 0, startedAt: new Date().toISOString() },
  );

  // joinRoom's own room_members notification to MEMBER_ID is itself a real, wire-authenticated directed send (P3.8, agent-comms#48) -- unreachable at join time, it queues and replays here too, alongside the "hello" retry this test is actually about. Assert on the "hello" message's own retry count rather than a bare total, so this test doesn't couple to how many other room-domain requests happen to be pending for the same member.
  await waitFor(
    () => attempts.filter((a) => textOf(a) === "hello").length === 2,
    "the queued send to retry once the member reconnects",
  );
});

test("the retry queue is bounded oldest-first per member", async () => {
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
  expect(attempts.length).toBe(QUEUE_CAP + overflow);

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

  expect(textOf(attempts[0])).toBe(`msg-${String(overflow)}`);
  expect(textOf(attempts[attempts.length - 1])).toBe(
    `msg-${String(QUEUE_CAP + overflow - 1)}`,
  );
});

test("a flush drops (not re-queues) a send whose room this store no longer holds a token for", async () => {
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
  expect(attempts.length).toBe(1);

  deleteRoomToken(slot, room.id);

  store.events.onPeerConnected(
    { id: MEMBER_ID },
    { id: MEMBER_ID, port: 0, startedAt: new Date().toISOString() },
  );
  // No token to present -- give the flush a moment to run, then confirm it made no further attempt.
  const FLUSH_GRACE_MS = 50;
  await new Promise((resolve) => {
    setTimeout(resolve, FLUSH_GRACE_MS);
  });
  expect(attempts.length).toBe(1);
});

/**
 * Integration test for the bound on a room.join awaiting a human decision (first-contact DM requests ride the same verb): the receiver expires an unanswered request and answers with a timeout, the requester's own call then rejects instead of hanging, and a decision made inside the window is unaffected.
 */

import { test, expect } from "vitest";
import { MeshStore } from "../core/mesh-store.js";
import { dmRoomPath } from "../core/room-path.js";
import { waitFor, wireTestTransport } from "./test-transport.js";

let nextPort = 23_450;
function freshPort(): number {
  nextPort += 1;
  return nextPort;
}

/** Short enough to keep the test fast, long enough that an immediate accept always lands inside it. */
const APPROVAL_WINDOW_MS = 600;

async function makeConnectedPair(
  port: number,
): Promise<{ a: MeshStore; b: MeshStore }> {
  const options = {
    coordinatorPort: port,
    roomJoinApprovalTimeoutMs: APPROVAL_WINDOW_MS,
  };
  const a = new MeshStore(options);
  await wireTestTransport(a);
  await a.init();
  await a.registerAgent({
    name: "a",
    harness: "test",
    cwd: "/test/a",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });

  const b = new MeshStore(options);
  await wireTestTransport(b);
  await b.init();
  await b.registerAgent({
    name: "b",
    harness: "test",
    cwd: "/test/b",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });

  await waitFor(
    () => a.serialise().agents[b.peerId] !== undefined,
    "a sees b's agent",
  );
  return { a, b };
}

test("an unanswered first sendDm rejects with a timeout once the approval window passes, and nothing is left pending or recorded", async () => {
  const { a, b } = await makeConnectedPair(freshPort());

  try {
    const dmPath = dmRoomPath(a.peerId, b.peerId);

    const send = a.sendDm(a.peerId, b.peerId, "anyone there");
    const settled = expect(send).rejects.toThrow(/was refused \(timeout\)/);
    await waitFor(
      () => b.listPendingRoomJoins().length === 1,
      "b sees a's pending DM request",
    );
    await settled;

    expect(b.listPendingRoomJoins()).toEqual([]);
    expect(a.serialise().dms[dmPath]).toBeUndefined();
  } finally {
    await b.shutdown();
    await a.shutdown();
  }
});

test("a decision inside the window still admits the requester, and the cleared window never fires afterwards", async () => {
  const { a, b } = await makeConnectedPair(freshPort());

  try {
    const dmPath = dmRoomPath(a.peerId, b.peerId);

    const first = a.sendDm(a.peerId, b.peerId, "first");
    await waitFor(
      () => b.listPendingRoomJoins().length === 1,
      "b sees a's pending DM request",
    );
    b.acceptRoomJoin(dmPath, a.peerId);
    const sent = await first;

    // Outlast the window: a leaked timer would resolve a stale decision or throw here.
    await new Promise((resolve) => {
      setTimeout(resolve, APPROVAL_WINDOW_MS * 2);
    });
    await waitFor(
      () =>
        (b.serialise().dms[dmPath] ?? []).some((m) => m.id === sent.message.id),
      "b received the first DM",
    );
    expect(b.listPendingRoomJoins()).toEqual([]);
  } finally {
    await b.shutdown();
    await a.shutdown();
  }
});

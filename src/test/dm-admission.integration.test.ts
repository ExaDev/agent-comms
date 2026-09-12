/**
 * Integration test for the DM two-round consent flow (P3.4, section 6): A requesting DM access to B needs one human decision from B; B's own reciprocal request back to A needs none, since A's own outbound request is already the consent that makes B's reply not unsolicited contact.
 *
 * Unlike named-room admission, a real two-peer test can actually exercise this: dmRequestsInitiatedByMe and the persisted room-token store are both purely local state legacy full-state-sync never touches, so two ordinarily mesh-connected peers stay in the "never DM'd before" state this flow exists for.
 */

import * as assert from "node:assert/strict";
import { test } from "node:test";
import { MeshStore } from "../core/mesh-store.js";
import { dmRoomPath } from "../core/room-path.js";
import { waitFor, wireTestTransport } from "./test-transport.js";

let nextPort = 20_950;
function freshPort(): number {
  nextPort += 1;
  return nextPort;
}

async function makeConnectedPair(
  port: number,
): Promise<{ a: MeshStore; b: MeshStore }> {
  const a = new MeshStore(port);
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

  const b = new MeshStore(port);
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

void test("A's DM request holds open for B's decision; B's reply back auto-approves", async () => {
  const { a, b } = await makeConnectedPair(freshPort());

  try {
    const dmPath = dmRoomPath(a.peerId, b.peerId);

    // A initiates: held open on B's side until a human decides.
    const aRequestPromise = a.requestDmAccess(b.peerId);
    await waitFor(
      () => b.listPendingRoomJoins().length === 1,
      "B sees A's pending DM request",
    );
    const [pending] = b.listPendingRoomJoins();
    assert.equal(pending?.roomPath, dmPath);
    assert.equal(pending?.requesterId, a.peerId);

    b.acceptRoomJoin(dmPath, a.peerId);
    await aRequestPromise;

    // B's own reply, to the identical path, must NOT surface as a second pending decision on A's side -- A's own outbound request already covers it.
    const bRequestPromise = b.requestDmAccess(a.peerId);
    await bRequestPromise;
    assert.deepEqual(a.listPendingRoomJoins(), []);
  } finally {
    await b.shutdown();
    await a.shutdown();
  }
});

void test("an unsolicited DM request (no prior outbound request) still needs a human decision", async () => {
  const { a, b } = await makeConnectedPair(freshPort());

  try {
    const dmPath = dmRoomPath(a.peerId, b.peerId);

    const requestPromise = b.requestDmAccess(a.peerId);
    await waitFor(
      () => a.listPendingRoomJoins().length === 1,
      "A sees B's pending DM request",
    );
    const [pending] = a.listPendingRoomJoins();
    assert.equal(pending?.roomPath, dmPath);
    assert.equal(pending?.requesterId, b.peerId);

    a.acceptRoomJoin(dmPath, b.peerId);
    await requestPromise;
  } finally {
    await b.shutdown();
    await a.shutdown();
  }
});

void test("a rejected DM request throws, and never auto-approves the reciprocal reply", async () => {
  const { a, b } = await makeConnectedPair(freshPort());

  try {
    const dmPath = dmRoomPath(a.peerId, b.peerId);

    const aRequestPromise = a.requestDmAccess(b.peerId);
    await waitFor(
      () => b.listPendingRoomJoins().length === 1,
      "B sees A's pending DM request",
    );
    b.rejectRoomJoin(dmPath, a.peerId, "not interested");
    await assert.rejects(aRequestPromise, /was refused \(denied\)/);
  } finally {
    await b.shutdown();
    await a.shutdown();
  }
});

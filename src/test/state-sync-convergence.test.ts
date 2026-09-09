/**
 * Unit tests for state_sync convergence (#27): entities that changed while a peer held a stale copy must converge on the fresher revision, in both directions — a stale holder heals when it receives a fresher snapshot, and a current holder rejects a stale snapshot instead of regressing.
 *
 * Also covers the append-only history merge: unseen messages are added and read receipts are unioned. These tests exercise the merge seam directly (no transport): the stores never connect, snapshots are exchanged through serialise() / applyStateSync().
 */

import * as assert from "node:assert/strict";
import { test } from "node:test";
import { MeshStore } from "../core/mesh-store.js";
import type { SerialisedState } from "../core/wire-protocol.js";

/** A local-only store: no transport start, so no ports and no flake. */
function makeStore(): MeshStore {
  return new MeshStore();
}

function snapshotOf(store: MeshStore): SerialisedState {
  return structuredClone(store.serialise());
}

void test("a stale holder converges when a fresher snapshot arrives", async () => {
  const a = makeStore();
  const b = makeStore();
  const agent = await a.registerAgent({
    name: "old-name",
    harness: "pi",
    cwd: "/tmp/p",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });

  // B holds the pre-rename copy.
  b.applyStateSync(snapshotOf(a));
  assert.equal((await b.getAgent(agent.id))?.name, "old-name");

  // A renames while B is away; B heals on A's next snapshot.
  await a.updateAgent(agent.id, { name: "new-name" });
  b.applyStateSync(snapshotOf(a));
  assert.equal((await b.getAgent(agent.id))?.name, "new-name");
});

void test("a current holder rejects a stale snapshot instead of regressing", async () => {
  const a = makeStore();
  const b = makeStore();
  const agent = await a.registerAgent({
    name: "old-name",
    harness: "pi",
    cwd: "/tmp/p",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });

  // B is current at the post-rename revision.
  await a.updateAgent(agent.id, { name: "new-name" });
  b.applyStateSync(snapshotOf(a));
  assert.equal((await b.getAgent(agent.id))?.name, "new-name");

  // A returning peer that still holds the pre-rename snapshot cannot regress B, where the old add-only merge kept whatever arrived first.
  const stale = snapshotOf(a);
  const staleAgent = stale.agents[agent.id];
  if (staleAgent === undefined) throw new Error("agent missing from snapshot");
  staleAgent.name = "old-name";
  staleAgent.version -= 1;
  b.applyStateSync(stale);
  assert.equal((await b.getAgent(agent.id))?.name, "new-name");
});

void test("room membership changes converge and stale member lists are rejected", async () => {
  const a = makeStore();
  const b = makeStore();
  const owner = await a.registerAgent({
    name: "owner",
    harness: "pi",
    cwd: "/tmp/p",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  const joiner = await b.registerAgent({
    name: "joiner",
    harness: "claude-code",
    cwd: "/tmp/j",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  await a.createRoom({
    name: "room",
    type: "public",
    owner: owner.id,
    description: "x",
  });

  // A holds the room before the join; the joiner lives on B, so the join
  // mutates B's copy and syncs back (one MeshStore is one peer identity, so
  // a second agent cannot be registered on A).
  a.applyStateSync(snapshotOf(b));
  b.applyStateSync(snapshotOf(a));
  assert.equal((await a.getRoom("room"))?.members.includes(joiner.id), false);

  await b.joinRoom("room", joiner.id);
  a.applyStateSync(snapshotOf(b));
  assert.equal((await a.getRoom("room"))?.members.includes(joiner.id), true);

  // The joiner leaves; A (now current) must drop them — the union-only merge
  // could never remove a leaver.
  await b.leaveRoom("room", joiner.id);
  a.applyStateSync(snapshotOf(b));
  assert.equal((await a.getRoom("room"))?.members.includes(joiner.id), false);

  // A stale member list that still contains them is rejected.
  const stale = snapshotOf(b);
  const staleRoom = stale.rooms.room;
  if (staleRoom === undefined) throw new Error("room missing from snapshot");
  staleRoom.members.push(joiner.id);
  staleRoom.version -= 1;
  a.applyStateSync(stale);
  assert.equal((await a.getRoom("room"))?.members.includes(joiner.id), false);
});

void test("history sync adds unseen messages and unions read receipts", async () => {
  const a = makeStore();
  const b = makeStore();
  const agent = await a.registerAgent({
    name: "sender",
    harness: "pi",
    cwd: "/tmp/p",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  await a.createRoom({
    name: "room",
    type: "public",
    owner: agent.id,
    description: "x",
  });
  await a.sendRoomMessage("room", agent.id, "one");
  b.applyStateSync(snapshotOf(a));

  // While B is away, a second message arrives and the first gains a reader elsewhere on the mesh; B's next sync takes both.
  await a.sendRoomMessage("room", agent.id, "two");
  const fresh = snapshotOf(a);
  const history = fresh.messages.room;
  if (history?.[0] === undefined)
    throw new Error("messages missing from snapshot");
  history[0].readBy.push("reader-elsewhere");
  b.applyStateSync(fresh);

  const merged = await b.readRoomMessages("room");
  assert.deepEqual(
    merged.map((m) => m.content),
    ["one", "two"],
  );
  assert.equal(merged[0]?.readBy.includes("reader-elsewhere"), true);
});

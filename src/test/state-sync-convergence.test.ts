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

void test("a kick racing a concurrent join converges with the kick honoured", async () => {
  // Two holders of the same room base: one records X leaving (a kick), the
  // other records X joining, both at the same revision because they mutated
  // concurrently from the same base. Both directions of the sync must
  // converge on X being out — the leave wins an exact tie (#27).
  const base = makeStore();
  const owner = await base.registerAgent({
    name: "owner",
    harness: "pi",
    cwd: "/tmp/p",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  const member = makeStore();
  const x = await member.registerAgent({
    name: "x",
    harness: "claude-code",
    cwd: "/tmp/x",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  await base.createRoom({
    name: "room",
    type: "public",
    owner: owner.id,
    description: "x",
  });
  await base.joinRoom("room", x.id);

  const kicker = makeStore();
  const joiner = makeStore();
  kicker.applyStateSync(snapshotOf(base));
  joiner.applyStateSync(snapshotOf(base));

  // Concurrent mutations from the same base: a kick on one holder, a
  // re-join of X recorded on the other.
  await kicker.leaveRoom("room", x.id);
  await joiner.joinRoom("room", x.id);
  assert.equal((await kicker.getRoom("room"))?.members.includes(x.id), false);
  assert.equal((await joiner.getRoom("room"))?.members.includes(x.id), true);

  // Exchange both ways: both converge on the kick.
  kicker.applyStateSync(snapshotOf(joiner));
  joiner.applyStateSync(snapshotOf(kicker));
  assert.equal((await kicker.getRoom("room"))?.members.includes(x.id), false);
  assert.equal((await joiner.getRoom("room"))?.members.includes(x.id), false);
});

void test("concurrent joins of different agents both survive the merge", async () => {
  // The property the old version-tie union existed to protect: two peers
  // each record a different agent joining from the same base, and the
  // merged room holds both.
  const base = makeStore();
  const owner = await base.registerAgent({
    name: "owner",
    harness: "pi",
    cwd: "/tmp/p",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  const agents = makeStore();
  const p = await agents.registerAgent({
    name: "p",
    harness: "claude-code",
    cwd: "/tmp/1",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  const q = await agents.registerAgent({
    name: "q",
    harness: "codex",
    cwd: "/tmp/2",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  await base.createRoom({
    name: "room",
    type: "public",
    owner: owner.id,
    description: "x",
  });
  base.applyStateSync(snapshotOf(agents));

  const holderA = makeStore();
  const holderB = makeStore();
  holderA.applyStateSync(snapshotOf(base));
  holderB.applyStateSync(snapshotOf(base));
  await holderA.joinRoom("room", p.id);
  await holderB.joinRoom("room", q.id);

  holderA.applyStateSync(snapshotOf(holderB));
  holderB.applyStateSync(snapshotOf(holderA));
  const mergedA = await holderA.getRoom("room");
  const mergedB = await holderB.getRoom("room");
  assert.equal(mergedA?.members.includes(p.id), true);
  assert.equal(mergedA?.members.includes(q.id), true);
  assert.deepEqual(mergedB?.members, mergedA?.members);
});

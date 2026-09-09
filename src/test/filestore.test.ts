/**
 * Tests for the FileStore, the filesystem-backed legacy store exported from the public API. Covers the membership operation maps (a pending invite must survive an unrelated join, #35) and record parsing (an unparseable record must surface, not read as an empty mesh, #32).
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { FileStore } from "../core/store.js";

function tempStore(): FileStore {
  const root = fs.mkdtempSync(path.join(tmpdir(), "agent-comms-filestore-"));
  return new FileStore(root);
}

void test("a pending invite survives an unrelated join to the room", async () => {
  const store = tempStore();
  const owner = await store.registerAgent({
    name: "owner",
    harness: "pi",
    cwd: "/tmp/p",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  const invitee = await store.registerAgent({
    name: "invitee",
    harness: "claude-code",
    cwd: "/tmp/i",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  const other = await store.registerAgent({
    name: "other",
    harness: "codex",
    cwd: "/tmp/o",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  await store.createRoom({
    name: "room",
    type: "public",
    owner: owner.id,
    description: "x",
  });
  await store.inviteToRoom("room", invitee.id, owner.id);
  assert.deepEqual((await store.getRoom("room"))?.invited, [invitee.id]);

  // Any later join re-derives the invited view from the operation maps; the pending invite must survive it (#35).
  await store.joinRoom("room", other.id);
  assert.deepEqual((await store.getRoom("room"))?.invited, [invitee.id]);
});

void test("declining and kicking clear the invited view consistently", async () => {
  const store = tempStore();
  const owner = await store.registerAgent({
    name: "owner",
    harness: "pi",
    cwd: "/tmp/p",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  const invitee = await store.registerAgent({
    name: "invitee",
    harness: "claude-code",
    cwd: "/tmp/i",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  await store.createRoom({
    name: "room",
    type: "private",
    owner: owner.id,
    description: "x",
  });
  await store.inviteToRoom("room", invitee.id, owner.id);
  await store.declineInvite("room", invitee.id, "not now");
  const declined = await store.getRoom("room");
  assert.deepEqual(declined?.invited, []);
  // Re-inviting after a decline works: the new join op outranks the leave.
  await store.inviteToRoom("room", invitee.id, owner.id);
  assert.deepEqual((await store.getRoom("room"))?.invited, [invitee.id]);
  await store.kickFromRoom("room", invitee.id, owner.id);
  assert.deepEqual((await store.getRoom("room"))?.invited, []);
  assert.equal(
    (await store.getRoom("room"))?.members.includes(invitee.id),
    false,
  );
});

void test("joining through an invitation consumes it", async () => {
  const store = tempStore();
  const owner = await store.registerAgent({
    name: "owner",
    harness: "pi",
    cwd: "/tmp/p",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  const invitee = await store.registerAgent({
    name: "invitee",
    harness: "claude-code",
    cwd: "/tmp/i",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  await store.createRoom({
    name: "room",
    type: "private",
    owner: owner.id,
    description: "x",
  });
  await store.inviteToRoom("room", invitee.id, owner.id);
  await store.joinRoom("room", invitee.id);
  const room = await store.getRoom("room");
  assert.deepEqual(room?.invited, []);
  assert.equal(room?.members.includes(invitee.id), true);
});

void test("an unparseable stored record surfaces instead of an empty list", async () => {
  const store = tempStore();
  await store.registerAgent({
    name: "good",
    harness: "pi",
    cwd: "/tmp/p",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  // A record missing the required fields (written by an older build, say) must raise from listAgents, not read as an empty mesh (#32).
  const agentsDir = path.join(store.root, "registry", "agents");
  fs.writeFileSync(path.join(agentsDir, "stale.json"), '{"id": "stale"}');
  await assert.rejects(
    store.listAgents("whoever"),
    (err: unknown) => err instanceof Error,
  );
});

void test("a store with no registry yet lists no agents", async () => {
  const store = tempStore();
  assert.deepEqual(await store.listAgents("whoever"), []);
});

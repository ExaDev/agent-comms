/**
 * Tests for the FileStore, the filesystem-backed legacy store exported from the public API. Covers the membership operation maps (a pending invite must survive an unrelated join, #35) and record parsing (an unparseable record must surface, not read as an empty mesh, #32).
 */

import * as fs from "node:fs";
import path from "node:path";
import { test, expect } from "vitest";
import { FileStore } from "../core/store.js";
import { scratchDirectory } from "./scratch-directory.helper.js";

function tempStore(): FileStore {
  const root = scratchDirectory("agent-comms-filestore-");
  return new FileStore(root);
}

test("a pending invite survives an unrelated join to the room", async () => {
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
  expect((await store.getRoom("room"))?.invited).toEqual([invitee.id]);

  // Any later join re-derives the invited view from the operation maps; the pending invite must survive it (#35).
  await store.joinRoom("room", other.id);
  expect((await store.getRoom("room"))?.invited).toEqual([invitee.id]);
});

test("declining and kicking clear the invited view consistently", async () => {
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
  expect(declined?.invited).toEqual([]);
  // Re-inviting after a decline works: the new join op outranks the leave.
  await store.inviteToRoom("room", invitee.id, owner.id);
  expect((await store.getRoom("room"))?.invited).toEqual([invitee.id]);
  await store.kickFromRoom("room", invitee.id, owner.id);
  expect((await store.getRoom("room"))?.invited).toEqual([]);
  expect((await store.getRoom("room"))?.members.includes(invitee.id)).toBe(
    false,
  );
});

test("joining through an invitation consumes it", async () => {
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
  expect(room?.invited).toEqual([]);
  expect(room?.members.includes(invitee.id)).toBe(true);
});

test("an unparseable stored record surfaces instead of an empty list", async () => {
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
  await expect(store.listAgents("whoever")).rejects.toBeInstanceOf(Error);
});

test("a store with no registry yet lists no agents", async () => {
  const store = tempStore();
  expect(await store.listAgents("whoever")).toEqual([]);
});

/** The one form the store writes: UTC, millisecond precision, fixed width, which makes UTF-16 order chronological. */
const TIMESTAMP_FORM = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

test("every timestamp the store writes has the one fixed UTC form its sorts rely on", async () => {
  const store = tempStore();
  const alice = await store.registerAgent({
    name: "alice",
    harness: "pi",
    cwd: "/tmp/a",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  const bob = await store.registerAgent({
    name: "bob",
    harness: "pi",
    cwd: "/tmp/b",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  const room = await store.createRoom({
    name: "room",
    type: "public",
    owner: alice.id,
    description: "x",
  });
  await store.sendRoomMessage(room.id, alice.id, "hello");
  await store.sendDm(alice.id, bob.id, "hi");

  const roomMessages = await store.readRoomMessages(room.id);
  const events = await store.drainDelivery(bob.id);
  const stamps = [
    ...roomMessages.map((message) => message.timestamp),
    ...events.flatMap((event) =>
      event.type === "room_message" || event.type === "dm"
        ? [event.message.timestamp]
        : [],
    ),
  ];

  expect(stamps.length).toBeGreaterThan(1);
  for (const stamp of stamps) expect(stamp).toMatch(TIMESTAMP_FORM);
});

/**
 * createRoom must accept an arbitrary caller-supplied name -- e.g. from a live create_room tool call, not just an internal cwd basename -- and sanitise it into the room-path grammar's [A-Za-z0-9_-]+ charset itself, rather than throwing on whatever a user happened to type. This is the one choke point every room creation goes through, so it is the right place to slug, not something every caller must remember to pre-slug.
 */

import * as assert from "node:assert/strict";
import { test } from "node:test";
import { MeshStore } from "../core/mesh-store.js";
import { ownerNamedRoomPath } from "../core/room-path.js";
import { wireTestTransport } from "./test-transport.js";

async function makeStore(): Promise<MeshStore> {
  const store = new MeshStore();
  await wireTestTransport(store);
  return store;
}

void test("createRoom sanitises a name containing spaces and dots instead of throwing", async () => {
  const store = await makeStore();
  const owner = await store.registerAgent({
    name: "owner",
    harness: "pi",
    cwd: "/tmp/p",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });

  const room = await store.createRoom({
    name: "my project.docs",
    type: "public",
    owner: owner.id,
    description: "x",
  });

  assert.equal(room.name, "my-project-docs");
  assert.equal(room.id, ownerNamedRoomPath(owner.id, "my-project-docs"));
});

void test("createRoom's sanitised id is what getRoom must be looked up by", async () => {
  const store = await makeStore();
  const owner = await store.registerAgent({
    name: "owner",
    harness: "pi",
    cwd: "/tmp/p",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });

  const room = await store.createRoom({
    name: "team chat",
    type: "public",
    owner: owner.id,
    description: "x",
  });

  const found = await store.getRoom(room.id);
  assert.equal(found?.name, "team-chat");
});

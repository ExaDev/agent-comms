/**
 * agent-comms#212 -- create a room, then address it by its plain local name (exactly as the README's own usage examples and CommsAction's documented `send`/`join_room`/etc parameters show, e.g. `target: "code-review"`) fails with ROOM_NOT_FOUND. MeshStore's real room identity is the owner-qualified `<owner-hex>/<local-name>` path (room-path.ts's ownerNamedRoomPath), which no caller can construct from a bare name alone -- these tests prove every room-touching tool action accepts the same plain name createRoom's own confirmation message and listRooms/read_room already surface back to the caller.
 */

import { describe, it, expect } from "vitest";
import { MeshStore } from "../core/mesh-store.js";
import { CommsTool } from "../core/tool.js";
import { buildAction } from "../core/bridge.js";
import { wireTestTransport } from "./test-transport.js";

const DEVICE_ID_HEX_LENGTH = 64;

async function makeToolAndOwner(): Promise<{
  store: MeshStore;
  tool: CommsTool;
  ctx: { agentId: string; harness: string; cwd: string; pid: number };
}> {
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
  const tool = new CommsTool(store);
  const ctx = {
    agentId: owner.id,
    harness: "pi",
    cwd: "/tmp/p",
    pid: process.pid,
  };
  return { store, tool, ctx };
}

describe("addressing a room by its plain local name", () => {
  it("send finds a just-created room by name, not just its full owner-qualified id", async () => {
    const { tool, ctx } = await makeToolAndOwner();

    const created = await tool.handle(
      ctx,
      buildAction({
        action: "create_room",
        room: "code-review",
        type: "public",
      }),
    );
    expect(created.isError).toBe(false);

    const sent = await tool.handle(
      ctx,
      buildAction({
        action: "send",
        target: "code-review",
        content: "Batch 3 done.",
      }),
    );

    expect(sent.isError).toBe(false);
    expect(sent.content).not.toContain("ROOM_NOT_FOUND");
  });

  it("join_room re-joining by name and read_room by name both succeed after create_room", async () => {
    const { tool, ctx } = await makeToolAndOwner();

    await tool.handle(
      ctx,
      buildAction({ action: "create_room", room: "general", type: "public" }),
    );

    const joined = await tool.handle(
      ctx,
      buildAction({ action: "join_room", room: "general" }),
    );
    expect(joined.isError).toBe(false);

    const read = await tool.handle(
      ctx,
      buildAction({ action: "read_room", room: "general" }),
    );
    expect(read.isError).toBe(false);
  });

  it("leave_room by name succeeds after create_room", async () => {
    const { tool, ctx } = await makeToolAndOwner();

    await tool.handle(
      ctx,
      buildAction({ action: "create_room", room: "standup", type: "public" }),
    );

    const left = await tool.handle(
      ctx,
      buildAction({ action: "leave_room", room: "standup" }),
    );
    expect(left.isError).toBe(false);
  });

  it("refuses to guess when two different owners' rooms share the same plain name", async () => {
    const { store, tool, ctx } = await makeToolAndOwner();
    const otherOwner = "b".repeat(DEVICE_ID_HEX_LENGTH);

    await tool.handle(
      ctx,
      buildAction({ action: "create_room", room: "general", type: "public" }),
    );
    // A second room, owned by a different device, that happens to share the same local name -- names are only unique per-owner, so this is a legitimate state to end up in (e.g. via legacy full-state replication), not something createRoom itself needs to prevent.
    await store.createRoom({
      name: "general",
      type: "public",
      owner: otherOwner,
      description: "",
    });

    const sent = await tool.handle(
      ctx,
      buildAction({ action: "send", target: "general", content: "hi" }),
    );

    expect(sent.isError).toBe(true);
    expect(sent.content).toContain("AMBIGUOUS_ROOM_NAME");
  });
});

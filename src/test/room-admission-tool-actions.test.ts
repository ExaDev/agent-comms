/**
 * Unit tests for the room_accept/room_reject/room_pending CommsTool actions -- the human-facing wrapper around MeshStore's own acceptRoomJoin/rejectRoomJoin/listPendingRoomJoins, additive alongside (never replacing) the existing mesh_accept/mesh_reject/mesh_pending connection-level actions.
 */

import { describe, it, expect } from "vitest";
import type { IncomingManageRequest } from "wire-mesh-core/domain/mesh-session";
import { MeshStore } from "../core/mesh-store.js";
import { CommsTool } from "../core/tool.js";
import { buildAction } from "../core/bridge.js";
import { wireTestTransport } from "./test-transport.js";

const REQUESTER_ID = "b".repeat(64);

function fakeJoinRequest(roomPath: string): IncomingManageRequest {
  return {
    requestId: 1,
    command: { verb: "room:member", params: { verb: "room.join" } },
    scope: { kind: "room", path: roomPath },
    respond: async () => {},
  };
}

describe("room admission CommsTool actions", () => {
  it("room_pending lists a held-open room.join request", async () => {
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
    const handler = store.roomVerbHandlers["room.join"];
    expect(handler).toBeTruthy();
    if (handler === undefined)
      throw new Error("expected a room.join handler to be registered");
    void handler(fakeJoinRequest(room.id), { id: REQUESTER_ID });

    const tool = new CommsTool(store);
    const ctx = {
      agentId: owner.id,
      harness: "pi",
      cwd: "/tmp/p",
      pid: process.pid,
    };
    const pendingResult = await tool.handle(
      ctx,
      buildAction({ action: "room_pending" }),
    );

    expect(pendingResult.isError).toBe(false);
    expect(pendingResult.content.includes(room.id)).toBeTruthy();
    expect(pendingResult.content.includes(REQUESTER_ID)).toBeTruthy();
  });

  it("room_accept grants the pending request", async () => {
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
    const handler = store.roomVerbHandlers["room.join"];
    expect(handler).toBeTruthy();
    if (handler === undefined)
      throw new Error("expected a room.join handler to be registered");
    const outcomePromise = handler(fakeJoinRequest(room.id), {
      id: REQUESTER_ID,
    });

    const tool = new CommsTool(store);
    const ctx = {
      agentId: owner.id,
      harness: "pi",
      cwd: "/tmp/p",
      pid: process.pid,
    };
    const acceptResult = await tool.handle(
      ctx,
      buildAction({
        action: "room_accept",
        room: room.id,
        requesterId: REQUESTER_ID,
      }),
    );

    expect(acceptResult.isError).toBe(false);
    const outcome = await outcomePromise;
    expect(outcome.result).toBe("ok");

    const pendingAfter = await tool.handle(
      ctx,
      buildAction({ action: "room_pending" }),
    );
    expect(pendingAfter.content).toBe("No pending room join requests.");
  });

  it("room_reject denies the pending request with an optional reason", async () => {
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
    const handler = store.roomVerbHandlers["room.join"];
    expect(handler).toBeTruthy();
    if (handler === undefined)
      throw new Error("expected a room.join handler to be registered");
    const outcomePromise = handler(fakeJoinRequest(room.id), {
      id: REQUESTER_ID,
    });

    const tool = new CommsTool(store);
    const ctx = {
      agentId: owner.id,
      harness: "pi",
      cwd: "/tmp/p",
      pid: process.pid,
    };
    const rejectResult = await tool.handle(
      ctx,
      buildAction({
        action: "room_reject",
        room: room.id,
        requesterId: REQUESTER_ID,
        reason: "not now",
      }),
    );

    expect(rejectResult.isError).toBe(false);
    const outcome = await outcomePromise;
    expect(outcome.result).toBe("error");
    if (outcome.result === "error") {
      expect(outcome.message).toBe("not now");
    }
  });

  it("room_accept on a store with no matching pending request reports failure, not a crash", async () => {
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

    const result = await tool.handle(
      ctx,
      buildAction({
        action: "room_accept",
        room: "not-a-real-room",
        requesterId: REQUESTER_ID,
      }),
    );

    expect(result.isError).toBe(true);
  });
});

/**
 * Unit tests for mesh-worker.ts's own local reducer -- applyPatch/applyStateSync/getStateSnapshot. The worker connects to exactly one server over one WebSocket (never multiple mesh peers directly), and the server has already computed the fully-merged, authoritative record before ever broadcasting a patch -- so unlike the server's own delivery-engine.ts, which genuinely needs version-gated CRDT merge to reconcile concurrent writes from multiple peers, the worker needs none of that: applying a patch should simply overwrite with whatever the server sent.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  agents,
  rooms,
  applyPatch,
  applyStateSync,
  getStateSnapshot,
} from "../mesh-worker.js";
import type { AgentIdentity, Room } from "../mesh-worker.js";

function agent(overrides: Partial<AgentIdentity> = {}): AgentIdentity {
  return {
    id: "agent-1",
    name: "agent-name",
    harness: "pi",
    cwd: "/tmp",
    pid: 1,
    startedAt: "2026-01-01T00:00:00.000Z",
    visibility: "visible",
    status: "active",
    tags: [],
    subscribedRooms: [],
    ...overrides,
  };
}

function room(overrides: Partial<Room> = {}): Room {
  return {
    id: "room-1",
    name: "room-name",
    type: "public",
    owner: "owner-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    description: "",
    members: [],
    invited: [],
    ...overrides,
  };
}

beforeEach(() => {
  agents.clear();
  rooms.clear();
});

describe("mesh-worker applyPatch(agent_upsert)", () => {
  it("overwrites subscribedRooms exactly as the server sent it, never resurrecting a room the server already removed", () => {
    agents.set(
      "agent-1",
      agent({ id: "agent-1", subscribedRooms: ["room-a", "room-b"] }),
    );

    applyPatch({
      type: "agent_upsert",
      agent: agent({ id: "agent-1", subscribedRooms: [] }),
    });

    expect(agents.get("agent-1")?.subscribedRooms).toEqual([]);
  });

  it("stores a brand-new agent as-is", () => {
    applyPatch({
      type: "agent_upsert",
      agent: agent({ id: "agent-2", name: "fresh" }),
    });
    expect(agents.get("agent-2")?.name).toBe("fresh");
  });
});

describe("mesh-worker applyPatch(room_upsert)", () => {
  it("overwrites members exactly as the server sent it, never resurrecting a member the server already removed", () => {
    rooms.set(
      "room-1",
      room({ id: "room-1", members: ["member-a", "member-b"] }),
    );

    applyPatch({
      type: "room_upsert",
      room: room({ id: "room-1", members: ["member-a"] }),
    });

    expect(rooms.get("room-1")?.members).toEqual(["member-a"]);
  });

  it("stores a brand-new room as-is", () => {
    applyPatch({
      type: "room_upsert",
      room: room({ id: "room-2", name: "fresh" }),
    });
    expect(rooms.get("room-2")?.name).toBe("fresh");
  });
});

describe("mesh-worker applyStateSync / getStateSnapshot", () => {
  it("populates local state from a full snapshot, readable back via getStateSnapshot", () => {
    applyStateSync({
      agents: { "agent-1": agent({ id: "agent-1", name: "synced" }) },
      rooms: { "room-1": room({ id: "room-1", name: "synced-room" }) },
      messages: {},
      dms: {},
    });
    const snapshot = getStateSnapshot();
    expect(snapshot.agents).toEqual([agent({ id: "agent-1", name: "synced" })]);
    expect(snapshot.rooms).toEqual([
      room({ id: "room-1", name: "synced-room" }),
    ]);
  });
});

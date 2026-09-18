/**
 * Unit tests for state.ts — client state management.
 */

import { describe, it, expect } from "vitest";
import { State } from "../state.js";
import type { Agent, MeshGraph, Room } from "../types.js";

/** A device-id is a hex-encoded SHA-256 hash: 32 bytes, 64 hex characters. */
const DEVICE_ID_HEX_LENGTH = 64;

const MOCK_AGENT: Agent = {
  id: "abc123",
  name: "Test Agent",
  harness: "pi",
  cwd: "/test",
  pid: 1234,
  startedAt: "2025-05-23T10:00:00Z",
  visibility: "visible",
  status: "active",
  tags: [],
  subscribedRooms: [],
};

const MOCK_ROOM: Room = {
  id: "test-room",
  name: "Test Room",
  type: "public",
  owner: "abc123",
  createdAt: "2025-05-23T10:00:00Z",
  description: "A test room",
  members: ["abc123"],
  invited: [],
};

describe("state", () => {
  it("starts with initial state", () => {
    const state = new State();
    const s = state.get();
    expect(s.currentRoom).toBe(undefined);
    expect(s.dmTarget).toBe(undefined);
    expect(s.agents).toEqual([]);
    expect(s.rooms).toEqual([]);
    expect(s.connected).toBe(false);
  });

  it("sets current room and notifies", () => {
    const state = new State();
    const notified: ReturnType<State["get"]>[] = [];
    state.subscribe((s) => {
      notified.push(s);
    });

    state.setCurrentRoom("room-1");
    expect(state.get().currentRoom).toBe("room-1");
    expect(notified.length).toBe(1);
    expect(notified[0]?.currentRoom).toBe("room-1");
  });

  it("sets agents and notifies", () => {
    const state = new State();
    state.setAgents([MOCK_AGENT]);
    expect(state.get().agents).toEqual([MOCK_AGENT]);
  });

  it("sets rooms and notifies", () => {
    const state = new State();
    state.setRooms([MOCK_ROOM]);
    expect(state.get().rooms).toEqual([MOCK_ROOM]);
  });

  it("sets connected and notifies", () => {
    const state = new State();
    state.setConnected(true);
    expect(state.get().connected).toBe(true);
  });

  it("starts with an undefined mesh graph", () => {
    const state = new State();
    expect(state.get().meshGraph).toBe(undefined);
  });

  it("sets meshGraph and notifies", () => {
    const state = new State();
    const graph: MeshGraph = {
      nodes: [
        "a".repeat(DEVICE_ID_HEX_LENGTH),
        "b".repeat(DEVICE_ID_HEX_LENGTH),
      ],
      edges: [
        {
          kind: "direct",
          from: "a".repeat(DEVICE_ID_HEX_LENGTH),
          to: "b".repeat(DEVICE_ID_HEX_LENGTH),
        },
      ],
    };
    state.setMeshGraph(graph);
    expect(state.get().meshGraph).toEqual(graph);
  });

  it("sets dmTarget and notifies", () => {
    const state = new State();
    const notified: ReturnType<State["get"]>[] = [];
    state.subscribe((s) => {
      notified.push(s);
    });

    state.setDmTarget("agent-42");
    expect(state.get().dmTarget).toBe("agent-42");
    expect(notified.length).toBe(1);
    expect(notified[0]?.dmTarget).toBe("agent-42");
  });

  it("sets dmTarget and notifies", () => {
    const state = new State();
    const notified: ReturnType<State["get"]>[] = [];
    state.subscribe((s) => {
      notified.push(s);
    });

    state.setDmTarget("agent-42");
    expect(state.get().dmTarget).toBe("agent-42");
    expect(notified.length).toBe(1);
    expect(notified[0]?.dmTarget).toBe("agent-42");
  });

  it("reset returns to initial state", () => {
    const state = new State();
    state.setCurrentRoom("room-1");
    state.setAgents([MOCK_AGENT]);
    state.setConnected(true);

    state.reset();
    const s = state.get();
    expect(s.currentRoom).toBe(undefined);
    expect(s.agents).toEqual([]);
    expect(s.connected).toBe(false);
  });

  it("unsubscribe stops notifications", () => {
    const state = new State();
    let count = 0;
    const unsub = state.subscribe(() => {
      count++;
    });

    state.setConnected(true);
    expect(count).toBe(1);

    unsub();
    state.setConnected(false);
    expect(count).toBe(1);
  });

  it("multiple subscribers all get notified", () => {
    const state = new State();
    let count1 = 0;
    let count2 = 0;
    state.subscribe(() => {
      count1++;
    });
    state.subscribe(() => {
      count2++;
    });

    state.setConnected(true);
    expect(count1).toBe(1);
    expect(count2).toBe(1);
  });
});

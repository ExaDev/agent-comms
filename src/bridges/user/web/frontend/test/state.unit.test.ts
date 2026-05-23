/* eslint-disable @typescript-eslint/no-floating-promises */
/**
 * Unit tests for state.ts — client state management.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { State } from "../state.js";
import type { Agent, Room } from "../types.js";

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
    assert.strictEqual(s.currentRoom, undefined);
    assert.strictEqual(s.dmTarget, undefined);
    assert.deepStrictEqual(s.agents, []);
    assert.deepStrictEqual(s.rooms, []);
    assert.strictEqual(s.connected, false);
  });

  it("sets current room and notifies", () => {
    const state = new State();
    const notified: ReturnType<State["get"]>[] = [];
    state.subscribe((s) => notified.push(s));

    state.setCurrentRoom("room-1");
    assert.strictEqual(state.get().currentRoom, "room-1");
    assert.strictEqual(notified.length, 1);
    assert.strictEqual(notified[0]?.currentRoom, "room-1");
  });

  it("sets agents and notifies", () => {
    const state = new State();
    state.setAgents([MOCK_AGENT]);
    assert.deepStrictEqual(state.get().agents, [MOCK_AGENT]);
  });

  it("sets rooms and notifies", () => {
    const state = new State();
    state.setRooms([MOCK_ROOM]);
    assert.deepStrictEqual(state.get().rooms, [MOCK_ROOM]);
  });

  it("sets connected and notifies", () => {
    const state = new State();
    state.setConnected(true);
    assert.strictEqual(state.get().connected, true);
  });

  it("applyState sets agents and rooms atomically", () => {
    const state = new State();
    const notified = Array<boolean>();
    state.subscribe(() => notified.push(true));

    state.applyState([MOCK_AGENT], [MOCK_ROOM]);
    assert.deepStrictEqual(state.get().agents, [MOCK_AGENT]);
    assert.deepStrictEqual(state.get().rooms, [MOCK_ROOM]);
    assert.strictEqual(notified.length, 1);
  });

  it("sets dmTarget and notifies", () => {
    const state = new State();
    const notified: ReturnType<State["get"]>[] = [];
    state.subscribe((s) => notified.push(s));

    state.setDmTarget("agent-42");
    assert.strictEqual(state.get().dmTarget, "agent-42");
    assert.strictEqual(notified.length, 1);
    assert.strictEqual(notified[0]?.dmTarget, "agent-42");
  });

  it("reset returns to initial state", () => {
    const state = new State();
    state.setCurrentRoom("room-1");
    state.setAgents([MOCK_AGENT]);
    state.setConnected(true);

    state.reset();
    const s = state.get();
    assert.strictEqual(s.currentRoom, undefined);
    assert.deepStrictEqual(s.agents, []);
    assert.strictEqual(s.connected, false);
  });

  it("unsubscribe stops notifications", () => {
    const state = new State();
    let count = 0;
    const unsub = state.subscribe(() => {
      count++;
    });

    state.setConnected(true);
    assert.strictEqual(count, 1);

    unsub();
    state.setConnected(false);
    assert.strictEqual(count, 1);
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
    assert.strictEqual(count1, 1);
    assert.strictEqual(count2, 1);
  });
});

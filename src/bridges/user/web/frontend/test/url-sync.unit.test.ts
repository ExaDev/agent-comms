/**
 * Unit tests for url-sync.ts — deep link parsing, resolution, and URL sync.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  parseDeepLink,
  resolveDeepLink,
  syncUrl,
} from "../url-sync.js";
import type { Room } from "../types.js";

// ---------------------------------------------------------------------------
// parseDeepLink
// ---------------------------------------------------------------------------

describe("parseDeepLink", () => {
  it("parses ?room= parameter", () => {
    const result = parseDeepLink("?room=my-room");
    assert.deepStrictEqual(result, { kind: "room", roomId: "my-room" });
  });

  it("parses ?dm= parameter", () => {
    const result = parseDeepLink("?dm=agent-123");
    assert.deepStrictEqual(result, { kind: "dm", agentId: "agent-123" });
  });

  it("parses ?cwd= parameter", () => {
    const result = parseDeepLink("?cwd=/path/to/project");
    assert.deepStrictEqual(result, { kind: "cwd", path: "/path/to/project" });
  });

  it("returns undefined for empty search string", () => {
    const result = parseDeepLink("");
    assert.strictEqual(result, undefined);
  });

  it("returns undefined for unrecognised parameters", () => {
    const result = parseDeepLink("?unknown=foo");
    assert.strictEqual(result, undefined);
  });

  it("prioritises ?room= over ?dm=", () => {
    const result = parseDeepLink("?room=room-1&dm=agent-1");
    assert.deepStrictEqual(result, { kind: "room", roomId: "room-1" });
  });

  it("prioritises ?dm= over ?cwd=", () => {
    const result = parseDeepLink("?dm=agent-1&cwd=/some/path");
    assert.deepStrictEqual(result, { kind: "dm", agentId: "agent-1" });
  });

  it("handles URL-encoded values", () => {
    const result = parseDeepLink("?cwd=%2Fusers%2Fjoe%2Fproject");
    assert.deepStrictEqual(result, {
      kind: "cwd",
      path: "/users/joe/project",
    });
  });
});

// ---------------------------------------------------------------------------
// resolveDeepLink
// ---------------------------------------------------------------------------

describe("resolveDeepLink", () => {
  const rooms: Room[] = [
    {
      id: "room-1",
      name: "General",
      type: "public",
      owner: "a",
      createdAt: "",
      description: "",
      members: [],
      invited: [],
    },
    {
      id: "project-room",
      name: "project-room",
      type: "public",
      owner: "a",
      createdAt: "",
      description: "Project room for /home/user/my-project",
      members: [],
      invited: [],
    },
  ];

  it("resolves a room deep link when room exists", () => {
    const link = parseDeepLink("?room=room-1")!;
    const resolved = resolveDeepLink(link, rooms);
    assert.deepStrictEqual(resolved, { kind: "room", targetId: "room-1" });
  });

  it("returns undefined for room deep link when room does not exist", () => {
    const link = parseDeepLink("?room=nonexistent")!;
    const resolved = resolveDeepLink(link, rooms);
    assert.strictEqual(resolved, undefined);
  });

  it("resolves a dm deep link directly without checking rooms", () => {
    const link = parseDeepLink("?dm=agent-123")!;
    const resolved = resolveDeepLink(link, rooms);
    assert.deepStrictEqual(resolved, { kind: "dm", targetId: "agent-123" });
  });

  it("resolves a cwd deep link to matching project room", () => {
    const link = parseDeepLink("?cwd=/home/user/my-project")!;
    const resolved = resolveDeepLink(link, rooms);
    assert.deepStrictEqual(resolved, { kind: "room", targetId: "project-room" });
  });

  it("returns undefined for cwd deep link with no matching project room", () => {
    const link = parseDeepLink("?cwd=/no/matching/path")!;
    const resolved = resolveDeepLink(link, rooms);
    assert.strictEqual(resolved, undefined);
  });

  it("resolves against empty rooms list", () => {
    const link = parseDeepLink("?room=room-1")!;
    const resolved = resolveDeepLink(link, []);
    assert.strictEqual(resolved, undefined);
  });
});

// ---------------------------------------------------------------------------
// syncUrl — requires DOM history API
// ---------------------------------------------------------------------------

describe("syncUrl", () => {
  let replaceStateCalls: Array<{ url: string }> = [];
  let originalHistory: unknown;
  let originalLocation: unknown;

  beforeEach(() => {
    replaceStateCalls = [];
    // Stub history.replaceState and location
    originalHistory = globalThis.history;
    originalLocation = globalThis.location;

    Object.defineProperty(globalThis, "history", {
      value: {
        replaceState(
          _data: unknown,
          _unused: string,
          url?: string,
        ): void {
          replaceStateCalls.push({ url: url ?? "" });
        },
      },
      writable: true,
      configurable: true,
    });

    Object.defineProperty(globalThis, "location", {
      value: {
        href: "http://localhost:19877/",
        pathname: "/",
        search: "",
        hash: "",
      },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "history", {
      value: originalHistory,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, "location", {
      value: originalLocation,
      writable: true,
      configurable: true,
    });
  });

  it("sets ?room= when currentRoom is provided", () => {
    syncUrl({ currentRoom: "my-room", dmTarget: undefined });
    assert.strictEqual(replaceStateCalls.length, 1);
    assert.ok(replaceStateCalls[0].url.includes("room=my-room"));
  });

  it("sets ?dm= when dmTarget is provided and no currentRoom", () => {
    syncUrl({ currentRoom: undefined, dmTarget: "agent-42" });
    assert.strictEqual(replaceStateCalls.length, 1);
    assert.ok(replaceStateCalls[0].url.includes("dm=agent-42"));
  });

  it("prefers currentRoom over dmTarget", () => {
    syncUrl({ currentRoom: "room-1", dmTarget: "agent-42" });
    assert.strictEqual(replaceStateCalls.length, 1);
    assert.ok(replaceStateCalls[0].url.includes("room=room-1"));
    assert.ok(!replaceStateCalls[0].url.includes("dm="));
  });

  it("clears params when neither is provided", () => {
    syncUrl({ currentRoom: undefined, dmTarget: undefined });
    assert.strictEqual(replaceStateCalls.length, 1);
    assert.ok(!replaceStateCalls[0].url.includes("room="));
    assert.ok(!replaceStateCalls[0].url.includes("dm="));
  });
});

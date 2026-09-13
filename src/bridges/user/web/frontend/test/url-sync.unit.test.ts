/**
 * Unit tests for url-sync.ts — deep link parsing, resolution, and URL sync.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { parseDeepLink, resolveDeepLink, syncUrl } from "../url-sync.js";
import type { Room } from "../types.js";

// ---------------------------------------------------------------------------
// parseDeepLink
// ---------------------------------------------------------------------------

describe("parseDeepLink", () => {
  it("parses ?room= parameter", () => {
    const result = parseDeepLink("?room=my-room");
    expect(result).toEqual({ kind: "room", roomId: "my-room" });
  });

  it("parses ?dm= parameter", () => {
    const result = parseDeepLink("?dm=agent-123");
    expect(result).toEqual({ kind: "dm", agentId: "agent-123" });
  });

  it("parses ?cwd= parameter", () => {
    const result = parseDeepLink("?cwd=/path/to/project");
    expect(result).toEqual({ kind: "cwd", path: "/path/to/project" });
  });

  it("returns undefined for empty search string", () => {
    const result = parseDeepLink("");
    expect(result).toBe(undefined);
  });

  it("returns undefined for unrecognised parameters", () => {
    const result = parseDeepLink("?unknown=foo");
    expect(result).toBe(undefined);
  });

  it("prioritises ?room= over ?dm=", () => {
    const result = parseDeepLink("?room=room-1&dm=agent-1");
    expect(result).toEqual({ kind: "room", roomId: "room-1" });
  });

  it("prioritises ?dm= over ?cwd=", () => {
    const result = parseDeepLink("?dm=agent-1&cwd=/some/path");
    expect(result).toEqual({ kind: "dm", agentId: "agent-1" });
  });

  it("handles URL-encoded values", () => {
    const result = parseDeepLink("?cwd=%2Fusers%2Fjoe%2Fproject");
    expect(result).toEqual({
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
    expect(resolved).toEqual({ kind: "room", targetId: "room-1" });
  });

  it("returns undefined for room deep link when room does not exist", () => {
    const link = parseDeepLink("?room=nonexistent")!;
    const resolved = resolveDeepLink(link, rooms);
    expect(resolved).toBe(undefined);
  });

  it("resolves a dm deep link directly without checking rooms", () => {
    const link = parseDeepLink("?dm=agent-123")!;
    const resolved = resolveDeepLink(link, rooms);
    expect(resolved).toEqual({ kind: "dm", targetId: "agent-123" });
  });

  it("resolves a cwd deep link to matching project room", () => {
    const link = parseDeepLink("?cwd=/home/user/my-project")!;
    const resolved = resolveDeepLink(link, rooms);
    expect(resolved).toEqual({
      kind: "room",
      targetId: "project-room",
    });
  });

  it("returns undefined for cwd deep link with no matching project room", () => {
    const link = parseDeepLink("?cwd=/no/matching/path")!;
    const resolved = resolveDeepLink(link, rooms);
    expect(resolved).toBe(undefined);
  });

  it("resolves against empty rooms list", () => {
    const link = parseDeepLink("?room=room-1")!;
    const resolved = resolveDeepLink(link, []);
    expect(resolved).toBe(undefined);
  });
});

// ---------------------------------------------------------------------------
// syncUrl — requires DOM history API
// ---------------------------------------------------------------------------

describe("syncUrl", () => {
  let replaceStateCalls: { url: string }[] = [];
  let originalHistory: unknown;
  let originalLocation: unknown;

  beforeEach(() => {
    replaceStateCalls = [];
    // Stub history.replaceState and location
    originalHistory = globalThis.history;
    originalLocation = globalThis.location;

    Object.defineProperty(globalThis, "history", {
      value: {
        replaceState(_data: unknown, _unused: string, url?: string): void {
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
    expect(replaceStateCalls.length).toBe(1);
    expect(replaceStateCalls[0].url.includes("room=my-room")).toBeTruthy();
  });

  it("sets ?dm= when dmTarget is provided and no currentRoom", () => {
    syncUrl({ currentRoom: undefined, dmTarget: "agent-42" });
    expect(replaceStateCalls.length).toBe(1);
    expect(replaceStateCalls[0].url.includes("dm=agent-42")).toBeTruthy();
  });

  it("prefers currentRoom over dmTarget", () => {
    syncUrl({ currentRoom: "room-1", dmTarget: "agent-42" });
    expect(replaceStateCalls.length).toBe(1);
    expect(replaceStateCalls[0].url.includes("room=room-1")).toBeTruthy();
    expect(!replaceStateCalls[0].url.includes("dm=")).toBeTruthy();
  });

  it("clears params when neither is provided", () => {
    syncUrl({ currentRoom: undefined, dmTarget: undefined });
    expect(replaceStateCalls.length).toBe(1);
    expect(!replaceStateCalls[0].url.includes("room=")).toBeTruthy();
    expect(!replaceStateCalls[0].url.includes("dm=")).toBeTruthy();
  });
});

/**
 * Unit tests for input.ts — command parsing.
 */

import { describe, it, expect } from "vitest";
import { parseInput, routeAction } from "../input.js";

describe("input", () => {
  describe("parseInput", () => {
    it("ignores empty input", () => {
      expect(parseInput("", undefined)).toEqual({ kind: "ignored" });
      expect(parseInput("   ", undefined)).toEqual({ kind: "ignored" });
    });

    it("returns error for message with no current room or DM target", () => {
      const result = parseInput("hello", undefined, undefined);
      expect(result.kind).toBe("local");
      if (result.kind === "local") {
        expect(result.result.type).toBe("error");
      }
    });

    it("returns DM action when DM target is set and no current room", () => {
      const result = parseInput("hello there", undefined, "agent-42");
      expect(result).toEqual({
        kind: "action",
        action: { action: "dm", target: "agent-42", content: "hello there" },
      });
    });

    it("prefers current room over DM target for plain text", () => {
      const result = parseInput("hello", "room-1", "agent-42");
      expect(result).toEqual({
        kind: "action",
        action: { action: "send", target: "room-1", content: "hello" },
      });
    });

    it("returns send action for message in current room", () => {
      const result = parseInput("hello there", "room-1");
      expect(result).toEqual({
        kind: "action",
        action: { action: "send", target: "room-1", content: "hello there" },
      });
    });

    it("parses /join command", () => {
      const result = parseInput("/join my-room", undefined);
      expect(result).toEqual({
        kind: "action",
        action: { action: "join_room", room: "my-room" },
      });
    });

    it("returns error for /join without room", () => {
      const result = parseInput("/join", undefined);
      expect(result.kind).toBe("local");
      if (result.kind === "local") {
        expect(result.result.type).toBe("error");
        expect(result.result.text.includes("Usage")).toBeTruthy();
      }
    });

    it("parses /leave with explicit room", () => {
      const result = parseInput("/leave room-1", undefined);
      expect(result).toEqual({
        kind: "action",
        action: { action: "leave_room", room: "room-1" },
      });
    });

    it("parses /leave with current room", () => {
      const result = parseInput("/leave", "current-room");
      expect(result).toEqual({
        kind: "action",
        action: { action: "leave_room", room: "current-room" },
      });
    });

    it("parses /dm command", () => {
      const result = parseInput("/dm agent-1 hello friend", undefined);
      expect(result).toEqual({
        kind: "action",
        action: { action: "dm", target: "agent-1", content: "hello friend" },
      });
    });

    it("returns error for /dm without target or message", () => {
      const result = parseInput("/dm", undefined);
      expect(result.kind).toBe("local");
      if (result.kind === "local") {
        expect(result.result.type).toBe("error");
      }
    });

    it("parses /create command", () => {
      const result = parseInput("/create new-room", undefined);
      expect(result).toEqual({
        kind: "action",
        action: { action: "create_room", name: "new-room", type: "public" },
      });
    });

    it("parses /destroy command", () => {
      const result = parseInput("/destroy old-room", undefined);
      expect(result).toEqual({
        kind: "action",
        action: { action: "destroy_room", room: "old-room" },
      });
    });

    it("parses /rooms command", () => {
      const result = parseInput("/rooms", undefined);
      expect(result).toEqual({
        kind: "action",
        action: { action: "list_rooms" },
      });
    });

    it("parses /agents command", () => {
      const result = parseInput("/agents", undefined);
      expect(result).toEqual({
        kind: "action",
        action: { action: "list_agents" },
      });
    });

    it("parses /help command", () => {
      const result = parseInput("/help", undefined);
      expect(result.kind).toBe("local");
      if (result.kind === "local") {
        expect(result.result.type).toBe("help");
        expect(result.result.text.includes("/join")).toBeTruthy();
        expect(result.result.text.includes("/dm")).toBeTruthy();
      }
    });

    it("returns unknown for unrecognized commands", () => {
      const result = parseInput("/foobar", undefined);
      expect(result.kind).toBe("local");
      if (result.kind === "local") {
        expect(result.result.type).toBe("unknown");
        expect(result.result.text.includes("/foobar")).toBeTruthy();
      }
    });

    it("parses /rename command", () => {
      const result = parseInput("/rename agent-1 New Name", undefined);
      expect(result).toEqual({
        kind: "action",
        action: {
          action: "rename_agent",
          agent: "agent-1",
          name: "New Name",
        },
      });
    });

    it("returns error for /rename without agent or name", () => {
      const result = parseInput("/rename", undefined);
      expect(result.kind).toBe("local");
      if (result.kind === "local") {
        expect(result.result.type).toBe("error");
        expect(result.result.text.includes("Usage")).toBeTruthy();
      }
    });

    it("includes /rename in help text", () => {
      const result = parseInput("/help", undefined);
      expect(result.kind).toBe("local");
      if (result.kind === "local") {
        expect(result.result.type).toBe("help");
        expect(result.result.text.includes("/rename")).toBeTruthy();
      }
    });
  });

  describe("routeAction", () => {
    it("routes join_room through local handler", () => {
      const result = parseInput("/join my-room", undefined);
      const route = routeAction(result);
      expect(route).toEqual({
        kind: "join_room",
        room: "my-room",
      });
    });

    it("routes leave_room through local handler", () => {
      const result = parseInput("/leave", "current-room");
      const route = routeAction(result);
      expect(route).toEqual({ kind: "leave_room" });
    });

    it("routes leave_room with explicit room through local handler", () => {
      const result = parseInput("/leave other-room", "current-room");
      const route = routeAction(result);
      expect(route).toEqual({ kind: "leave_room" });
    });

    it("returns null for send action", () => {
      const result = parseInput("hello", "room-1");
      expect(routeAction(result)).toBe(null);
    });

    it("returns null for DM action", () => {
      const result = parseInput("hello", undefined, "agent-1");
      expect(routeAction(result)).toBe(null);
    });

    it("returns null for local results", () => {
      const result = parseInput("/help", undefined);
      expect(routeAction(result)).toBe(null);
    });

    it("returns null for ignored input", () => {
      const result = parseInput("", undefined);
      expect(routeAction(result)).toBe(null);
    });
  });
});

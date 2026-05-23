/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/no-unnecessary-condition */
/**
 * Unit tests for input.ts — command parsing.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseInput } from "../input.js";

describe("input", () => {
  describe("parseInput", () => {
    it("ignores empty input", () => {
      assert.deepStrictEqual(parseInput("", undefined), { kind: "ignored" });
      assert.deepStrictEqual(parseInput("   ", undefined), { kind: "ignored" });
    });

    it("returns error for message with no current room", () => {
      const result = parseInput("hello", undefined);
      assert.strictEqual(result.kind, "local");
      if (result.kind === "local") {
        assert.strictEqual(result.result.type, "error");
      }
    });

    it("returns send action for message in current room", () => {
      const result = parseInput("hello there", "room-1");
      assert.deepStrictEqual(result, {
        kind: "action",
        action: { action: "send", target: "room-1", content: "hello there" },
      });
    });

    it("parses /join command", () => {
      const result = parseInput("/join my-room", undefined);
      assert.deepStrictEqual(result, {
        kind: "action",
        action: { action: "join_room", room: "my-room" },
      });
    });

    it("returns error for /join without room", () => {
      const result = parseInput("/join", undefined);
      assert.strictEqual(result.kind, "local");
      if (result.kind === "local") {
        assert.strictEqual(result.result.type, "error");
        assert.ok(result.result.text.includes("Usage"));
      }
    });

    it("parses /leave with explicit room", () => {
      const result = parseInput("/leave room-1", undefined);
      assert.deepStrictEqual(result, {
        kind: "action",
        action: { action: "leave_room", room: "room-1" },
      });
    });

    it("parses /leave with current room", () => {
      const result = parseInput("/leave", "current-room");
      assert.deepStrictEqual(result, {
        kind: "action",
        action: { action: "leave_room", room: "current-room" },
      });
    });

    it("parses /dm command", () => {
      const result = parseInput("/dm agent-1 hello friend", undefined);
      assert.deepStrictEqual(result, {
        kind: "action",
        action: { action: "dm", target: "agent-1", content: "hello friend" },
      });
    });

    it("returns error for /dm without target or message", () => {
      const result = parseInput("/dm", undefined);
      assert.strictEqual(result.kind, "local");
      if (result.kind === "local") {
        assert.strictEqual(result.result.type, "error");
      }
    });

    it("parses /create command", () => {
      const result = parseInput("/create new-room", undefined);
      assert.deepStrictEqual(result, {
        kind: "action",
        action: { action: "create_room", name: "new-room", type: "public" },
      });
    });

    it("parses /destroy command", () => {
      const result = parseInput("/destroy old-room", undefined);
      assert.deepStrictEqual(result, {
        kind: "action",
        action: { action: "destroy_room", room: "old-room" },
      });
    });

    it("parses /rooms command", () => {
      const result = parseInput("/rooms", undefined);
      assert.deepStrictEqual(result, {
        kind: "action",
        action: { action: "list_rooms" },
      });
    });

    it("parses /agents command", () => {
      const result = parseInput("/agents", undefined);
      assert.deepStrictEqual(result, {
        kind: "action",
        action: { action: "list_agents" },
      });
    });

    it("parses /help command", () => {
      const result = parseInput("/help", undefined);
      assert.strictEqual(result.kind, "local");
      if (result.kind === "local") {
        assert.strictEqual(result.result.type, "help");
        assert.ok(result.result.text.includes("/join"));
        assert.ok(result.result.text.includes("/dm"));
      }
    });

    it("returns unknown for unrecognized commands", () => {
      const result = parseInput("/foobar", undefined);
      assert.strictEqual(result.kind, "local");
      if (result.kind === "local") {
        assert.strictEqual(result.result.type, "unknown");
        assert.ok(result.result.text.includes("/foobar"));
      }
    });
  });
});

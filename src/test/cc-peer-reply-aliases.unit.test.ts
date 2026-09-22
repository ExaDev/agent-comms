/**
 * Unit tests for the cc-peer front's reply-alias bookkeeping (bridges/cc-peer/reply-aliases.ts) — alias-name derivation, the correspondent↔alias↔context directory, and which DeliveryEvent types carry a repliable target worth aliasing, all tested purely over data with no real cc-peer/AliasPool involved.
 */
import { describe, expect, it } from "vitest";
import {
  deriveAliasName,
  replyTargetForEvent,
  ReplyAliasDirectory,
} from "../bridges/cc-peer/reply-aliases.js";
import type { DeliveryEvent, DmMessage, RoomMessage } from "../core/types.js";

function dmMessage(overrides: Partial<DmMessage> = {}): DmMessage {
  return {
    id: "msg-1",
    from: "a1b2c3d4e5f60000000000000000000000000000000000000000000000000000",
    to: "agent-1",
    content: "hi",
    timestamp: "2026-01-01T00:00:00.000Z",
    readBy: [],
    ...overrides,
  };
}

function roomMessage(overrides: Partial<RoomMessage> = {}): RoomMessage {
  return {
    id: "msg-1",
    from: "f1e2d3c4b5a60000000000000000000000000000000000000000000000000000",
    room: "owner/project",
    content: "hi",
    timestamp: "2026-01-01T00:00:00.000Z",
    readBy: [],
    ...overrides,
  };
}

describe("deriveAliasName", () => {
  it("derives a stable, non-empty peer name from a correspondent id", () => {
    const name = deriveAliasName("a1b2c3d4e5f6789012345678");
    expect(name.length).toBeGreaterThan(0);
    expect(name).toBe(deriveAliasName("a1b2c3d4e5f6789012345678"));
  });

  it("derives distinct names for distinct correspondent ids", () => {
    expect(deriveAliasName("aaaaaaaaaaaaaaaaaaaaaaaa")).not.toBe(
      deriveAliasName("bbbbbbbbbbbbbbbbbbbbbbbb"),
    );
  });

  it("is stable even for a very short correspondent id", () => {
    expect(deriveAliasName("ab").length).toBeGreaterThan(0);
  });
});

describe("replyTargetForEvent", () => {
  it("returns the sender's agent id with a dm context for a dm event", () => {
    const event: DeliveryEvent = {
      type: "dm",
      message: dmMessage({ from: "sender-id" }),
    };
    expect(replyTargetForEvent(event)).toEqual({
      correspondentId: "sender-id",
      context: { kind: "dm" },
    });
  });

  it("returns the sender's agent id with a room context naming the room for a room_message event", () => {
    const event: DeliveryEvent = {
      type: "room_message",
      message: roomMessage({ from: "sender-id", room: "owner/project" }),
    };
    expect(replyTargetForEvent(event)).toEqual({
      correspondentId: "sender-id",
      context: { kind: "room", room: "owner/project" },
    });
  });

  it("names whichever room the room_message actually came from, not a fixed default", () => {
    const event: DeliveryEvent = {
      type: "room_message",
      message: roomMessage({ from: "sender-id", room: "owner/other-room" }),
    };
    expect(replyTargetForEvent(event)).toEqual({
      correspondentId: "sender-id",
      context: { kind: "room", room: "owner/other-room" },
    });
  });

  it("returns undefined for an event with no single originating correspondent", () => {
    const event: DeliveryEvent = {
      type: "member_joined",
      room: "owner/project",
      agent: "agent-1",
    };
    expect(replyTargetForEvent(event)).toBeUndefined();
  });
});

describe("ReplyAliasDirectory", () => {
  it("mints a fresh alias name the first time a correspondent is seen", () => {
    const directory = new ReplyAliasDirectory();
    const name = directory.ensure("correspondent-1", { kind: "dm" });
    expect(name.length).toBeGreaterThan(0);
  });

  it("is idempotent: the same correspondent always maps to the same alias name", () => {
    const directory = new ReplyAliasDirectory();
    const first = directory.ensure("correspondent-1", { kind: "dm" });
    const second = directory.ensure("correspondent-1", {
      kind: "room",
      room: "owner/project",
    });
    expect(second).toBe(first);
  });

  it("gives distinct correspondents distinct alias names", () => {
    const directory = new ReplyAliasDirectory();
    const a = directory.ensure("aaaaaaaaaaaaaaaaaaaaaaaa", { kind: "dm" });
    const b = directory.ensure("bbbbbbbbbbbbbbbbbbbbbbbb", { kind: "dm" });
    expect(a).not.toBe(b);
  });

  it("resolves a minted alias name back to its correspondent id", () => {
    const directory = new ReplyAliasDirectory();
    const name = directory.ensure("correspondent-1", { kind: "dm" });
    expect(directory.correspondentFor(name)).toBe("correspondent-1");
  });

  it("returns undefined for an alias name it never minted", () => {
    const directory = new ReplyAliasDirectory();
    expect(directory.correspondentFor("never-seen")).toBeUndefined();
  });

  it("resolves a minted alias name back to the context it was minted with", () => {
    const directory = new ReplyAliasDirectory();
    const name = directory.ensure("correspondent-1", {
      kind: "room",
      room: "owner/project",
    });
    expect(directory.contextFor(name)).toEqual({
      kind: "room",
      room: "owner/project",
    });
  });

  it("returns undefined context for an alias name it never minted", () => {
    const directory = new ReplyAliasDirectory();
    expect(directory.contextFor("never-seen")).toBeUndefined();
  });

  it("updates the alias's own context on every call, reflecting the most recently sent event rather than the one that first minted it", () => {
    const directory = new ReplyAliasDirectory();
    const name = directory.ensure("correspondent-1", { kind: "dm" });
    expect(directory.contextFor(name)).toEqual({ kind: "dm" });

    directory.ensure("correspondent-1", {
      kind: "room",
      room: "owner/project",
    });
    expect(directory.contextFor(name)).toEqual({
      kind: "room",
      room: "owner/project",
    });

    directory.ensure("correspondent-1", { kind: "dm" });
    expect(directory.contextFor(name)).toEqual({ kind: "dm" });
  });
});

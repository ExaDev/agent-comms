/**
 * Unit tests for messages.ts — delivery event → display message conversion.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deliveryEventToMessage,
  roomMessageToDisplay,
} from "../messages.js";
import type { DeliveryEvent, RoomMessage } from "../types.js";

const MOCK_MESSAGE: RoomMessage = {
  id: "msg-1",
  from: "agent-1",
  room: "room-1",
  content: "Hello world",
  timestamp: "2025-05-23T14:30:45.123Z",
  readBy: [],
};

describe("deliveryEventToMessage", () => {
  describe("room_message", () => {
    it("converts room_message for current room", () => {
      const event: DeliveryEvent = {
        type: "room_message",
        message: MOCK_MESSAGE,
      };
      const result = deliveryEventToMessage(event, "room-1");
      assert.deepStrictEqual(result, {
        type: "chat",
        sender: "agent-1",
        content: "Hello world",
        timestamp: "2025-05-23T14:30:45.123Z",
      });
    });

    it("returns undefined for room_message in other room", () => {
      const event: DeliveryEvent = {
        type: "room_message",
        message: MOCK_MESSAGE,
      };
      const result = deliveryEventToMessage(event, "other-room");
      assert.strictEqual(result, undefined);
    });

    it("returns undefined for room_message with no current room", () => {
      const event: DeliveryEvent = {
        type: "room_message",
        message: MOCK_MESSAGE,
      };
      const result = deliveryEventToMessage(event, undefined);
      assert.strictEqual(result, undefined);
    });
  });

  describe("dm", () => {
    it("converts dm regardless of current room", () => {
      const event: DeliveryEvent = {
        type: "dm",
        message: {
          id: "dm-1",
          from: "a1",
          to: "a2",
          content: "hey",
          timestamp: "2025-05-23T14:30:45Z",
          readBy: [],
        },
      };
      const result = deliveryEventToMessage(event, undefined);
      assert.deepStrictEqual(result, {
        type: "dm",
        sender: "a1",
        content: "hey",
        timestamp: "2025-05-23T14:30:45Z",
      });
    });
  });

  describe("member_joined", () => {
    it("converts to system message", () => {
      const event: DeliveryEvent = {
        type: "member_joined",
        room: "r1",
        agent: "a1",
      };
      const result = deliveryEventToMessage(event, "r1");
      assert.deepStrictEqual(result, {
        type: "system",
        text: "a1 joined r1",
      });
    });
  });

  describe("member_left", () => {
    it("converts to system message", () => {
      const event: DeliveryEvent = {
        type: "member_left",
        room: "r1",
        agent: "a1",
      };
      const result = deliveryEventToMessage(event, "r1");
      assert.deepStrictEqual(result, {
        type: "system",
        text: "a1 left r1",
      });
    });
  });

  describe("member_status", () => {
    it("converts to status message", () => {
      const event: DeliveryEvent = {
        type: "member_status",
        room: "r1",
        agent: "a1",
        status: "busy",
      };
      const result = deliveryEventToMessage(event, "r1");
      assert.strictEqual(result?.type, "status");
      assert.ok(result?.text?.includes("a1 is now busy"));
    });
  });

  describe("delivery_status", () => {
    it("converts to status message", () => {
      const event: DeliveryEvent = {
        type: "delivery_status",
        messageId: "msg-1",
        agent: "a1",
        status: "delivered",
      };
      const result = deliveryEventToMessage(event, undefined);
      assert.strictEqual(result?.type, "status");
      assert.ok(result?.text?.includes("delivered"));
    });
  });

  describe("room_members", () => {
    it("converts for current room", () => {
      const event: DeliveryEvent = {
        type: "room_members",
        room: "r1",
        members: [
          { id: "a1", name: "Alice", status: "active" },
          { id: "a2", name: "Bob", status: "idle" },
        ],
      };
      const result = deliveryEventToMessage(event, "r1");
      assert.strictEqual(result?.type, "system");
      assert.ok(result?.text?.includes("Alice"));
      assert.ok(result?.text?.includes("Bob"));
    });

    it("returns undefined for other room", () => {
      const event: DeliveryEvent = {
        type: "room_members",
        room: "r1",
        members: [{ id: "a1", name: "Alice", status: "active" }],
      };
      const result = deliveryEventToMessage(event, "other-room");
      assert.strictEqual(result, undefined);
    });
  });

  describe("room_invite", () => {
    it("converts with description", () => {
      const event: DeliveryEvent = {
        type: "room_invite",
        room: "r1",
        roomDescription: "A cool room",
        from: "a1",
        fromName: "Alice",
        fromCwd: "/home",
      };
      const result = deliveryEventToMessage(event, undefined);
      assert.strictEqual(result?.type, "system");
      assert.ok(result?.text?.includes("Alice"));
      assert.ok(result?.text?.includes("r1"));
      assert.ok(result?.text?.includes("A cool room"));
    });

    it("converts without description", () => {
      const event: DeliveryEvent = {
        type: "room_invite",
        room: "r1",
        roomDescription: "",
        from: "a1",
        fromName: "Alice",
        fromCwd: "/home",
      };
      const result = deliveryEventToMessage(event, undefined);
      assert.strictEqual(result?.type, "system");
      assert.ok(result?.text?.includes("Alice"));
      assert.ok(!result?.text?.includes(" — "));
    });
  });

  describe("invite_declined", () => {
    it("converts with reason", () => {
      const event: DeliveryEvent = {
        type: "invite_declined",
        room: "r1",
        agent: "a1",
        agentName: "Alice",
        reason: "Too busy",
      };
      const result = deliveryEventToMessage(event, undefined);
      assert.strictEqual(result?.type, "system");
      assert.ok(result?.text?.includes("Alice"));
      assert.ok(result?.text?.includes("Too busy"));
    });
  });
});

describe("roomMessageToDisplay", () => {
  it("converts a room message to a chat display message", () => {
    const result = roomMessageToDisplay(MOCK_MESSAGE);
    assert.deepStrictEqual(result, {
      type: "chat",
      sender: "agent-1",
      content: "Hello world",
      timestamp: "2025-05-23T14:30:45.123Z",
    });
  });
});

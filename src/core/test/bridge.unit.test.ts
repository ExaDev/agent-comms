/**
 * Unit tests for bridge.ts — formatDeliveryEvent.
 */

import { describe, it, expect } from "vitest";
import { formatDeliveryEvent, isActionableEvent } from "../bridge.js";
import type { DeliveryEvent } from "../types.js";

describe("formatDeliveryEvent", () => {
  it("formats name_changed event", () => {
    const event: DeliveryEvent = {
      type: "name_changed",
      agent: "abc123",
      oldName: "Alice",
      newName: "Bob",
    };
    const result = formatDeliveryEvent(event);
    expect(result).toBe("Alice is now known as Bob");
  });

  it("formats room_message", () => {
    const event: DeliveryEvent = {
      type: "room_message",
      message: {
        id: "m1",
        from: "a1",
        room: "r1",
        content: "hello",
        timestamp: "2025-01-01T00:00:00Z",
        readBy: [],
      },
    };
    const result = formatDeliveryEvent(event);
    expect(result).toBe("[r1] a1: hello");
  });

  it("formats member_status", () => {
    const event: DeliveryEvent = {
      type: "member_status",
      room: "r1",
      agent: "a1",
      status: "busy",
    };
    const result = formatDeliveryEvent(event);
    expect(result).toBe("a1 is now busy in r1");
  });
});

describe("isActionableEvent", () => {
  it("classifies room_message as actionable", () => {
    const event: DeliveryEvent = {
      type: "room_message",
      message: {
        id: "m1",
        from: "a1",
        room: "r1",
        content: "hello",
        timestamp: "2025-01-01T00:00:00Z",
        readBy: [],
      },
    };
    expect(isActionableEvent(event)).toBe(true);
  });

  it("classifies dm as actionable", () => {
    const event: DeliveryEvent = {
      type: "dm",
      message: {
        id: "dm1",
        from: "a1",
        to: "a2",
        content: "hey",
        timestamp: "2025-01-01T00:00:00Z",
        readBy: [],
      },
    };
    expect(isActionableEvent(event)).toBe(true);
  });

  it("classifies room_invite as actionable", () => {
    const event: DeliveryEvent = {
      type: "room_invite",
      room: "r1",
      roomDescription: "",
      from: "a1",
      fromName: "Alice",
      fromCwd: "/home",
    };
    expect(isActionableEvent(event)).toBe(true);
  });

  it("classifies member_joined as informational", () => {
    const event: DeliveryEvent = {
      type: "member_joined",
      room: "r1",
      agent: "a1",
    };
    expect(isActionableEvent(event)).toBe(false);
  });

  it("classifies member_status as informational", () => {
    const event: DeliveryEvent = {
      type: "member_status",
      room: "r1",
      agent: "a1",
      status: "offline",
    };
    expect(isActionableEvent(event)).toBe(false);
  });

  it("classifies name_changed as informational", () => {
    const event: DeliveryEvent = {
      type: "name_changed",
      agent: "a1",
      oldName: "Alice",
      newName: "Bob",
    };
    expect(isActionableEvent(event)).toBe(false);
  });

  it("classifies delivery_status as informational", () => {
    const event: DeliveryEvent = {
      type: "delivery_status",
      messageId: "m1",
      agent: "a1",
      status: "delivered",
    };
    expect(isActionableEvent(event)).toBe(false);
  });
});

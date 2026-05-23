/**
 * Unit tests for render.ts — DOM rendering functions.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import {
  clearMessages,
  renderAgentList,
  renderChatMessage,
  renderDeliveryEvent,
  renderDmMessage,
  renderHeader,
  renderMessageHistory,
  renderRoomList,
  renderSystemMessage,
} from "../render.js";
import type { DeliveryEvent, Room, RoomMessage, Agent } from "../types.js";

function createDoc(): {
  doc: Document;
  messagesEl: HTMLElement;
  roomListEl: HTMLElement;
  agentListEl: HTMLElement;
  headerEl: HTMLElement;
  cleanup: () => void;
} {
  const window = new Window();
  const doc = window.document as unknown as Document;

  const messagesEl = doc.createElement("div");
  const roomListEl = doc.createElement("div");
  const agentListEl = doc.createElement("div");
  const headerEl = doc.createElement("div");

  return {
    doc,
    messagesEl,
    roomListEl,
    agentListEl,
    headerEl,
    cleanup: () => {
      window.close();
    },
  };
}

const MOCK_MESSAGE: RoomMessage = {
  id: "msg-1",
  from: "agent-1",
  room: "room-1",
  content: "Hello world",
  timestamp: "2025-05-23T14:30:45.123Z",
  readBy: [],
};

describe("render", () => {
  describe("renderChatMessage", () => {
    it("appends a message element with sender and time", () => {
      const { doc, messagesEl, cleanup } = createDoc();
      try {
        renderChatMessage(
          doc,
          { messagesEl },
          "Alice",
          "Hello",
          "2025-05-23T14:30:45Z",
        );
        assert.strictEqual(messagesEl.children.length, 1);
        const el = messagesEl.children[0] as HTMLElement;
        assert.strictEqual(el.className, "msg");
        assert.ok(el.innerHTML.includes("Alice"));
        assert.ok(el.innerHTML.includes("14:30:45"));
        assert.ok(el.innerHTML.includes("Hello"));
      } finally {
        cleanup();
      }
    });

    it("calls onSelect with agent ID when agent is clicked", () => {
      const { doc, roomListEl, agentListEl, cleanup } = createDoc();
      try {
        const agents: Agent[] = [
          {
            id: "a1",
            name: "Agent 1",
            harness: "pi",
            cwd: "/t",
            pid: 1,
            startedAt: "",
            visibility: "visible",
            status: "active",
            tags: [],
            subscribedRooms: [],
          },
        ];
        let selectedId: string | undefined;
        renderAgentList(
          doc,
          { roomListEl, agentListEl },
          agents,
          (id) => {
            selectedId = id;
          },
        );

        const item = agentListEl.children[0] as HTMLElement;
        item.click();
        assert.strictEqual(selectedId, "a1");
      } finally {
        cleanup();
      }
    });
  });

  describe("renderDmMessage", () => {
    it("appends a DM message with badge", () => {
      const { doc, messagesEl, cleanup } = createDoc();
      try {
        renderDmMessage(
          doc,
          { messagesEl },
          "Bob",
          "Private msg",
          "2025-05-23T14:30:45Z",
        );
        const el = messagesEl.children[0] as HTMLElement;
        assert.strictEqual(el.className, "msg dm");
        assert.ok(el.innerHTML.includes("DM"));
        assert.ok(el.innerHTML.includes("Bob"));
      } finally {
        cleanup();
      }
    });
  });

  describe("renderSystemMessage", () => {
    it("appends an italic system message", () => {
      const { doc, messagesEl, cleanup } = createDoc();
      try {
        renderSystemMessage(doc, { messagesEl }, "Connected");
        const el = messagesEl.children[0] as HTMLElement;
        assert.strictEqual(el.className, "msg system");
        assert.strictEqual(el.textContent, "Connected");
      } finally {
        cleanup();
      }
    });
  });

  describe("clearMessages", () => {
    it("removes all message elements", () => {
      const { doc, messagesEl, cleanup } = createDoc();
      try {
        renderSystemMessage(doc, { messagesEl }, "one");
        renderSystemMessage(doc, { messagesEl }, "two");
        assert.strictEqual(messagesEl.children.length, 2);

        clearMessages({ messagesEl });
        assert.strictEqual(messagesEl.children.length, 0);
      } finally {
        cleanup();
      }
    });
  });

  describe("renderHeader", () => {
    it("sets header text", () => {
      const { headerEl, cleanup } = createDoc();
      try {
        renderHeader({ headerEl }, "test-room");
        assert.strictEqual(headerEl.textContent, "test-room");
      } finally {
        cleanup();
      }
    });
  });

  describe("renderRoomList", () => {
    it("renders rooms with active state", () => {
      const { doc, roomListEl, agentListEl, cleanup } = createDoc();
      try {
        const rooms: Room[] = [
          {
            id: "r1",
            name: "Room 1",
            type: "public",
            owner: "a",
            createdAt: "",
            description: "",
            members: ["a", "b"],
            invited: [],
          },
          {
            id: "r2",
            name: "Room 2",
            type: "private",
            owner: "a",
            createdAt: "",
            description: "",
            members: ["a"],
            invited: [],
          },
        ];
        let joinedRoom: string | undefined;
        renderRoomList(doc, { roomListEl, agentListEl }, rooms, "r1", (id) => {
          joinedRoom = id;
        });

        assert.strictEqual(roomListEl.children.length, 2);
        assert.strictEqual(
          (roomListEl.children[0] as HTMLElement).className,
          "room-item active",
        );
        assert.strictEqual(
          (roomListEl.children[1] as HTMLElement).className,
          "room-item",
        );

        // Click handler works
        (roomListEl.children[1] as HTMLElement).click();
        assert.strictEqual(joinedRoom, "r2");
      } finally {
        cleanup();
      }
    });
  });

  describe("renderAgentList", () => {
    it("renders empty list when no agents", () => {
      const { doc, roomListEl, agentListEl, cleanup } = createDoc();
      try {
        renderAgentList(doc, { roomListEl, agentListEl }, []);
        assert.strictEqual(agentListEl.children.length, 0);
      } finally {
        cleanup();
      }
    });

    it("renders agents with status dots", () => {
      const { doc, roomListEl, agentListEl, cleanup } = createDoc();
      try {
        const agents: Agent[] = [
          {
            id: "a1",
            name: "Agent 1",
            harness: "pi",
            cwd: "/t",
            pid: 1,
            startedAt: "",
            visibility: "visible",
            status: "active",
            tags: [],
            subscribedRooms: [],
          },
          {
            id: "a2",
            name: "Agent 2",
            harness: "pi",
            cwd: "/t",
            pid: 2,
            startedAt: "",
            visibility: "visible",
            status: "idle",
            tags: [],
            subscribedRooms: [],
          },
        ];
        renderAgentList(doc, { roomListEl, agentListEl }, agents);

        assert.strictEqual(agentListEl.children.length, 2);
        assert.ok(
          (agentListEl.children[0] as HTMLElement).innerHTML.includes(
            "Agent 1",
          ),
        );
      } finally {
        cleanup();
      }
    });

    it("calls onSelect with agent ID when agent is clicked", () => {
      const { doc, roomListEl, agentListEl, cleanup } = createDoc();
      try {
        const agents: Agent[] = [
          {
            id: "a1",
            name: "Agent 1",
            harness: "pi",
            cwd: "/t",
            pid: 1,
            startedAt: "",
            visibility: "visible",
            status: "active",
            tags: [],
            subscribedRooms: [],
          },
        ];
        let selectedId: string | undefined;
        renderAgentList(doc, { roomListEl, agentListEl }, agents, (id) => {
          selectedId = id;
        });

        const item = agentListEl.children[0] as HTMLElement;
        item.click();
        assert.strictEqual(selectedId, "a1");
      } finally {
        cleanup();
      }
    });
  });

  describe("renderDeliveryEvent", () => {
    it("renders room_message for current room", () => {
      const { doc, messagesEl, cleanup } = createDoc();
      try {
        const event: DeliveryEvent = {
          type: "room_message",
          message: MOCK_MESSAGE,
        };
        renderDeliveryEvent(doc, { messagesEl }, event, "room-1");
        assert.strictEqual(messagesEl.children.length, 1);
      } finally {
        cleanup();
      }
    });

    it("skips room_message for other rooms", () => {
      const { doc, messagesEl, cleanup } = createDoc();
      try {
        const event: DeliveryEvent = {
          type: "room_message",
          message: MOCK_MESSAGE,
        };
        renderDeliveryEvent(doc, { messagesEl }, event, "other-room");
        assert.strictEqual(messagesEl.children.length, 0);
      } finally {
        cleanup();
      }
    });

    it("renders dm regardless of current room", () => {
      const { doc, messagesEl, cleanup } = createDoc();
      try {
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
        renderDeliveryEvent(doc, { messagesEl }, event, undefined);
        assert.strictEqual(messagesEl.children.length, 1);
        assert.strictEqual(
          (messagesEl.children[0] as HTMLElement).className,
          "msg dm",
        );
      } finally {
        cleanup();
      }
    });

    it("renders member_joined as system message", () => {
      const { doc, messagesEl, cleanup } = createDoc();
      try {
        const event: DeliveryEvent = {
          type: "member_joined",
          room: "r1",
          agent: "a1",
        };
        renderDeliveryEvent(doc, { messagesEl }, event, "r1");
        assert.strictEqual(
          (messagesEl.children[0] as HTMLElement).textContent,
          "a1 joined r1",
        );
      } finally {
        cleanup();
      }
    });

    it("renders member_left as system message", () => {
      const { doc, messagesEl, cleanup } = createDoc();
      try {
        const event: DeliveryEvent = {
          type: "member_left",
          room: "r1",
          agent: "a1",
        };
        renderDeliveryEvent(doc, { messagesEl }, event, "r1");
        assert.strictEqual(
          (messagesEl.children[0] as HTMLElement).textContent,
          "a1 left r1",
        );
      } finally {
        cleanup();
      }
    });

    it("renders member_status as status message", () => {
      const { doc, messagesEl, cleanup } = createDoc();
      try {
        const event: DeliveryEvent = {
          type: "member_status",
          room: "r1",
          agent: "a1",
          status: "busy",
        };
        renderDeliveryEvent(doc, { messagesEl }, event, "r1");
        assert.strictEqual(
          (messagesEl.children[0] as HTMLElement).className,
          "msg status",
        );
        assert.ok(
          (messagesEl.children[0] as HTMLElement).textContent?.includes(
            "a1 is now busy",
          ),
        );
      } finally {
        cleanup();
      }
    });

    it("renders delivery_status as status message", () => {
      const { doc, messagesEl, cleanup } = createDoc();
      try {
        const event: DeliveryEvent = {
          type: "delivery_status",
          messageId: "msg-1",
          agent: "a1",
          status: "delivered",
        };
        renderDeliveryEvent(doc, { messagesEl }, event, undefined);
        assert.strictEqual(
          (messagesEl.children[0] as HTMLElement).className,
          "msg status",
        );
        assert.ok(
          (messagesEl.children[0] as HTMLElement).textContent?.includes(
            "delivered",
          ),
        );
      } finally {
        cleanup();
      }
    });

    it("renders room_members for current room", () => {
      const { doc, messagesEl, cleanup } = createDoc();
      try {
        const event: DeliveryEvent = {
          type: "room_members",
          room: "r1",
          members: [
            { id: "a1", name: "Alice", status: "active" },
            { id: "a2", name: "Bob", status: "idle" },
          ],
        };
        renderDeliveryEvent(doc, { messagesEl }, event, "r1");
        const text = (messagesEl.children[0] as HTMLElement).textContent ?? "";
        assert.ok(text.includes("Alice"));
        assert.ok(text.includes("Bob"));
      } finally {
        cleanup();
      }
    });

    it("skips room_members for other room", () => {
      const { doc, messagesEl, cleanup } = createDoc();
      try {
        const event: DeliveryEvent = {
          type: "room_members",
          room: "r1",
          members: [{ id: "a1", name: "Alice", status: "active" }],
        };
        renderDeliveryEvent(doc, { messagesEl }, event, "other-room");
        assert.strictEqual(messagesEl.children.length, 0);
      } finally {
        cleanup();
      }
    });

    it("renders room_invite with description", () => {
      const { doc, messagesEl, cleanup } = createDoc();
      try {
        const event: DeliveryEvent = {
          type: "room_invite",
          room: "r1",
          roomDescription: "A cool room",
          from: "a1",
          fromName: "Alice",
          fromCwd: "/home",
        };
        renderDeliveryEvent(doc, { messagesEl }, event, undefined);
        const text = (messagesEl.children[0] as HTMLElement).textContent ?? "";
        assert.ok(text.includes("Alice"));
        assert.ok(text.includes("r1"));
        assert.ok(text.includes("A cool room"));
      } finally {
        cleanup();
      }
    });

    it("renders invite_declined with reason", () => {
      const { doc, messagesEl, cleanup } = createDoc();
      try {
        const event: DeliveryEvent = {
          type: "invite_declined",
          room: "r1",
          agent: "a1",
          agentName: "Alice",
          reason: "Too busy",
        };
        renderDeliveryEvent(doc, { messagesEl }, event, undefined);
        const text = (messagesEl.children[0] as HTMLElement).textContent ?? "";
        assert.ok(text.includes("Alice"));
        assert.ok(text.includes("Too busy"));
      } finally {
        cleanup();
      }
    });
  });

    it("renders member_left as system message", () => {
      const { doc, messagesEl, cleanup } = createDoc();
      try {
        const event: DeliveryEvent = {
          type: "member_left",
          room: "r1",
          agent: "a1",
        };
        renderDeliveryEvent(doc, { messagesEl }, event, "r1");
        assert.strictEqual(
          (messagesEl.children[0] as HTMLElement).textContent,
          "a1 left r1",
        );
      } finally {
        cleanup();
      }
    });

    it("renders member_status as status message", () => {
      const { doc, messagesEl, cleanup } = createDoc();
      try {
        const event: DeliveryEvent = {
          type: "member_status",
          room: "r1",
          agent: "a1",
          status: "busy",
        };
        renderDeliveryEvent(doc, { messagesEl }, event, "r1");
        assert.strictEqual(
          (messagesEl.children[0] as HTMLElement).className,
          "msg status",
        );
        assert.ok(
          (messagesEl.children[0] as HTMLElement).textContent?.includes(
            "a1 is now busy",
          ),
        );
      } finally {
        cleanup();
      }
    });

    it("renders delivery_status as status message", () => {
      const { doc, messagesEl, cleanup } = createDoc();
      try {
        const event: DeliveryEvent = {
          type: "delivery_status",
          messageId: "msg-1",
          agent: "a1",
          status: "delivered",
        };
        renderDeliveryEvent(doc, { messagesEl }, event, undefined);
        assert.strictEqual(
          (messagesEl.children[0] as HTMLElement).className,
          "msg status",
        );
        assert.ok(
          (messagesEl.children[0] as HTMLElement).textContent?.includes(
            "delivered",
          ),
        );
      } finally {
        cleanup();
      }
    });

    it("renders room_members for current room", () => {
      const { doc, messagesEl, cleanup } = createDoc();
      try {
        const event: DeliveryEvent = {
          type: "room_members",
          room: "r1",
          members: [
            { id: "a1", name: "Alice", status: "active" },
            { id: "a2", name: "Bob", status: "idle" },
          ],
        };
        renderDeliveryEvent(doc, { messagesEl }, event, "r1");
        const text = (messagesEl.children[0] as HTMLElement).textContent ?? "";
        assert.ok(text.includes("Alice"));
        assert.ok(text.includes("Bob"));
      } finally {
        cleanup();
      }
    });

    it("skips room_members for other room", () => {
      const { doc, messagesEl, cleanup } = createDoc();
      try {
        const event: DeliveryEvent = {
          type: "room_members",
          room: "r1",
          members: [{ id: "a1", name: "Alice", status: "active" }],
        };
        renderDeliveryEvent(doc, { messagesEl }, event, "other-room");
        assert.strictEqual(messagesEl.children.length, 0);
      } finally {
        cleanup();
      }
    });

    it("renders room_invite with description", () => {
      const { doc, messagesEl, cleanup } = createDoc();
      try {
        const event: DeliveryEvent = {
          type: "room_invite",
          room: "r1",
          roomDescription: "A cool room",
          from: "a1",
          fromName: "Alice",
          fromCwd: "/home",
        };
        renderDeliveryEvent(doc, { messagesEl }, event, undefined);
        const text = (messagesEl.children[0] as HTMLElement).textContent ?? "";
        assert.ok(text.includes("Alice"));
        assert.ok(text.includes("r1"));
        assert.ok(text.includes("A cool room"));
      } finally {
        cleanup();
      }
    });

    it("renders invite_declined with reason", () => {
      const { doc, messagesEl, cleanup } = createDoc();
      try {
        const event: DeliveryEvent = {
          type: "invite_declined",
          room: "r1",
          agent: "a1",
          agentName: "Alice",
          reason: "Too busy",
        };
        renderDeliveryEvent(doc, { messagesEl }, event, undefined);
        const text = (messagesEl.children[0] as HTMLElement).textContent ?? "";
        assert.ok(text.includes("Alice"));
        assert.ok(text.includes("Too busy"));
      } finally {
        cleanup();
      }
    });
  });

  describe("renderMessageHistory", () => {
    it("renders multiple messages in order", () => {
      const { doc, messagesEl, cleanup } = createDoc();
      try {
        const messages: RoomMessage[] = [
          { ...MOCK_MESSAGE, id: "1", content: "First" },
          { ...MOCK_MESSAGE, id: "2", content: "Second" },
        ];
        renderMessageHistory(doc, { messagesEl }, messages);
        assert.strictEqual(messagesEl.children.length, 2);
      } finally {
        cleanup();
      }
    });
  });
});

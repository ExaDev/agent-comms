/**
 * Unit tests for Preact components — render into happy-dom containers.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { render as preactRender } from "preact";
import { Window } from "happy-dom";
import { Message } from "../components/Message.js";
import { MessageList } from "../components/MessageList.js";
import { ChatArea } from "../components/ChatArea.js";
import { Sidebar } from "../components/Sidebar.js";
import type {
  Agent,
  DisplayMessage,
  Room,
} from "../types.js";

let windowRef: Window | undefined;

function setup(): { container: HTMLElement; cleanup: () => void } {
  windowRef = new Window();
  const doc = (windowRef as unknown as { document: Document }).document;
  // Preact's JSX transform may reference globalThis.document
  (globalThis as Record<string, unknown>).document = doc;
  const container = doc.createElement("div");
  return {
    container,
    cleanup: () => {
      delete (globalThis as Record<string, unknown>).document;
      windowRef?.close();
      windowRef = undefined;
    },
  };
}

const MOCK_CHAT: DisplayMessage = {
  type: "chat",
  sender: "Alice",
  content: "Hello world",
  timestamp: "2025-05-23T14:30:45Z",
};

const MOCK_DM: DisplayMessage = {
  type: "dm",
  sender: "Bob",
  content: "Private msg",
  timestamp: "2025-05-23T14:30:45Z",
};

const MOCK_SYSTEM: DisplayMessage = {
  type: "system",
  text: "Connected",
};

const MOCK_STATUS: DisplayMessage = {
  type: "status",
  text: "Agent is now busy",
};

const MOCK_ROOM: Room = {
  id: "r1",
  name: "Room 1",
  type: "public",
  owner: "a",
  createdAt: "",
  description: "",
  members: ["a", "b"],
  invited: [],
};

const MOCK_AGENT: Agent = {
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
};

describe("Message component", () => {
  it("renders chat message with sender and time", () => {
    const { container, cleanup } = setup();
    try {
      preactRender(<Message message={MOCK_CHAT} />, container);
      const el = container.querySelector(".msg") as HTMLElement;
      assert.ok(el);
      assert.ok(el.textContent?.includes("Alice"));
      assert.ok(el.textContent?.includes("14:30:45"));
      assert.ok(el.textContent?.includes("Hello world"));
    } finally {
      cleanup();
    }
  });

  it("renders DM message with badge", () => {
    const { container, cleanup } = setup();
    try {
      preactRender(<Message message={MOCK_DM} />, container);
      const el = container.querySelector(".msg.dm") as HTMLElement;
      assert.ok(el);
      assert.ok(el.textContent?.includes("DM"));
      assert.ok(el.textContent?.includes("Bob"));
    } finally {
      cleanup();
    }
  });

  it("renders system message", () => {
    const { container, cleanup } = setup();
    try {
      preactRender(<Message message={MOCK_SYSTEM} />, container);
      const el = container.querySelector(".msg.system") as HTMLElement;
      assert.ok(el);
      assert.strictEqual(el.textContent, "Connected");
    } finally {
      cleanup();
    }
  });

  it("renders status message", () => {
    const { container, cleanup } = setup();
    try {
      preactRender(<Message message={MOCK_STATUS} />, container);
      const el = container.querySelector(".msg.status") as HTMLElement;
      assert.ok(el);
      assert.ok(el.textContent?.includes("busy"));
    } finally {
      cleanup();
    }
  });
});

describe("MessageList component", () => {
  it("renders multiple messages", () => {
    const { container, cleanup } = setup();
    try {
      preactRender(
        <MessageList messages={[MOCK_CHAT, MOCK_DM, MOCK_SYSTEM]} />,
        container,
      );
      const msgs = container.querySelectorAll(".msg");
      assert.strictEqual(msgs.length, 3);
    } finally {
      cleanup();
    }
  });

  it("renders empty list", () => {
    const { container, cleanup } = setup();
    try {
      preactRender(<MessageList messages={[]} />, container);
      const msgs = container.querySelectorAll(".msg");
      assert.strictEqual(msgs.length, 0);
    } finally {
      cleanup();
    }
  });
});

describe("ChatArea component", () => {
  it("renders header with default text", () => {
    const { container, cleanup } = setup();
    try {
      preactRender(
        <ChatArea
          messages={[]}
          currentRoom={undefined}
          dmTarget={undefined}
          onSendAction={() => {}}
          onLeaveRoom={() => {}}
        />,
        container,
      );
      const header = container.querySelector("#header") as HTMLElement;
      assert.ok(header);
      assert.ok(header.textContent?.includes("Select a room"));
    } finally {
      cleanup();
    }
  });

  it("renders header with room name and leave button", () => {
    const { container, cleanup } = setup();
    try {
      preactRender(
        <ChatArea
          messages={[]}
          currentRoom="test-room"
          dmTarget={undefined}
          onSendAction={() => {}}
          onLeaveRoom={() => {}}
        />,
        container,
      );
      const header = container.querySelector("#header") as HTMLElement;
      assert.ok(header.textContent?.includes("test-room"));
      const leaveBtn = container.querySelector(".leave-btn") as HTMLElement;
      assert.ok(leaveBtn, "leave button should be present when room is active");
    } finally {
      cleanup();
    }
  });

  it("renders header with DM target", () => {
    const { container, cleanup } = setup();
    try {
      preactRender(
        <ChatArea
          messages={[]}
          currentRoom={undefined}
          dmTarget="agent-1"
          onSendAction={() => {}}
          onLeaveRoom={() => {}}
        />,
        container,
      );
      const header = container.querySelector("#header") as HTMLElement;
      assert.ok(header.textContent?.includes("DM with agent-1"));
    } finally {
      cleanup();
    }
  });

  it("does not show leave button without active room", () => {
    const { container, cleanup } = setup();
    try {
      preactRender(
        <ChatArea
          messages={[]}
          currentRoom={undefined}
          dmTarget={undefined}
          onSendAction={() => {}}
          onLeaveRoom={() => {}}
        />,
        container,
      );
      const leaveBtn = container.querySelector(".leave-btn");
      assert.strictEqual(leaveBtn, null);
    } finally {
      cleanup();
    }
  });

  it("renders input bar", () => {
    const { container, cleanup } = setup();
    try {
      preactRender(
        <ChatArea
          messages={[]}
          currentRoom={undefined}
          dmTarget={undefined}
          onSendAction={() => {}}
          onLeaveRoom={() => {}}
        />,
        container,
      );
      const input = container.querySelector("#input") as HTMLElement;
      assert.ok(input);
      const sendBtn = container.querySelector("#send-btn") as HTMLElement;
      assert.ok(sendBtn);
    } finally {
      cleanup();
    }
  });
});

describe("Sidebar component", () => {
  it("renders rooms with active state", () => {
    const { container, cleanup } = setup();
    try {
      preactRender(
        <Sidebar
          rooms={[MOCK_ROOM]}
          agents={[]}
          currentRoom="r1"
          onJoinRoom={() => {}}
          onSelectAgent={() => {}}
          onCreateRoom={() => {}}
          onJoinRoomInput={() => {}}
        />,
        container,
      );
      const roomItem = container.querySelector(".room-item") as HTMLElement;
      assert.ok(roomItem);
      assert.ok(roomItem.classList.contains("active"));
      assert.ok(roomItem.textContent?.includes("Room 1"));
    } finally {
      cleanup();
    }
  });

  it("renders agents with status dots", () => {
    const { container, cleanup } = setup();
    try {
      preactRender(
        <Sidebar
          rooms={[]}
          agents={[MOCK_AGENT]}
          currentRoom={undefined}
          onJoinRoom={() => {}}
          onSelectAgent={() => {}}
          onCreateRoom={() => {}}
          onJoinRoomInput={() => {}}
        />,
        container,
      );
      const agentItem = container.querySelector(".agent-item") as HTMLElement;
      assert.ok(agentItem);
      assert.ok(agentItem.textContent?.includes("Agent 1"));
      const dot = container.querySelector(".status-dot") as HTMLElement;
      assert.ok(dot);
      assert.ok(dot.classList.contains("active"));
    } finally {
      cleanup();
    }
  });

  it("renders empty agent list", () => {
    const { container, cleanup } = setup();
    try {
      preactRender(
        <Sidebar
          rooms={[]}
          agents={[]}
          currentRoom={undefined}
          onJoinRoom={() => {}}
          onSelectAgent={() => {}}
          onCreateRoom={() => {}}
          onJoinRoomInput={() => {}}
        />,
        container,
      );
      const agents = container.querySelectorAll(".agent-item");
      assert.strictEqual(agents.length, 0);
    } finally {
      cleanup();
    }
  });

  it("renders create room toggle button", () => {
    const { container, cleanup } = setup();
    try {
      preactRender(
        <Sidebar
          rooms={[]}
          agents={[]}
          currentRoom={undefined}
          onJoinRoom={() => {}}
          onSelectAgent={() => {}}
          onCreateRoom={() => {}}
          onJoinRoomInput={() => {}}
        />,
        container,
      );
      const btn = container.querySelector(
        "#create-room-toggle",
      ) as HTMLElement;
      assert.ok(btn);
      assert.strictEqual(btn.textContent, "+");
    } finally {
      cleanup();
    }
  });

  it("renders join room toggle button", () => {
    const { container, cleanup } = setup();
    try {
      preactRender(
        <Sidebar
          rooms={[]}
          agents={[]}
          currentRoom={undefined}
          onJoinRoom={() => {}}
          onSelectAgent={() => {}}
          onCreateRoom={() => {}}
          onJoinRoomInput={() => {}}
        />,
        container,
      );
      const btn = container.querySelector(
        "#join-toggle-btn",
      ) as HTMLElement;
      assert.ok(btn);
    } finally {
      cleanup();
    }
  });
});

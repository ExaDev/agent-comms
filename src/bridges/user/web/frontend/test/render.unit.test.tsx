// @vitest-environment jsdom
/**
 * Unit tests for React components — render via Testing Library.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { Message } from "../components/Message.js";
import { MessageList } from "../components/MessageList.js";
import { ChatArea } from "../components/ChatArea.js";
import { Sidebar } from "../components/Sidebar.js";
import type { Agent, DisplayMessage, Room } from "../types.js";
import { stubMantineJsdomGlobals } from "./jsdom-mantine-polyfills.js";
import { renderWithMantine } from "./render-with-mantine.js";

beforeEach(() => {
  stubMantineJsdomGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

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

const SIDEBAR_DEFAULTS = {
  onSelectAgent: () => {},
  onRenameAgent: () => {},
  onCreateRoom: () => {},
  onJoinRoomInput: () => {},
};

describe("Message component", () => {
  it("renders chat message with sender and time", () => {
    renderWithMantine(<Message message={MOCK_CHAT} />);
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("14:30:45")).toBeInTheDocument();
    expect(screen.getByText(": Hello world")).toBeInTheDocument();
  });

  it("renders DM message with badge", () => {
    renderWithMantine(<Message message={MOCK_DM} />);
    expect(screen.getByText("DM")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
  });

  it("renders system message", () => {
    renderWithMantine(<Message message={MOCK_SYSTEM} />);
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });

  it("renders status message", () => {
    renderWithMantine(<Message message={MOCK_STATUS} />);
    expect(screen.getByText("Agent is now busy")).toBeInTheDocument();
  });
});

const MOCK_MESSAGE_COUNT = 3;

describe("MessageList component", () => {
  it("renders multiple messages", () => {
    renderWithMantine(
      <MessageList messages={[MOCK_CHAT, MOCK_DM, MOCK_SYSTEM]} />,
    );
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });

  it("renders empty list", () => {
    renderWithMantine(<MessageList messages={[]} />);
    expect(screen.getByLabelText("Messages").textContent).toBe("");
  });
});

describe("ChatArea component", () => {
  const chatAreaDefaults = {
    messages: [] as readonly DisplayMessage[],
    connected: true,
    sidebarOpened: true,
    onToggleSidebar: () => {},
    onSendAction: () => {},
    onLeaveRoom: () => {},
    onConnectToMesh: () => {},
  };

  it("renders header with default text", () => {
    renderWithMantine(
      <ChatArea
        {...chatAreaDefaults}
        currentRoom={undefined}
        dmTarget={undefined}
      />,
    );
    expect(screen.getByText("Select a room")).toBeInTheDocument();
  });

  it("renders header with room name and leave button", () => {
    renderWithMantine(
      <ChatArea
        {...chatAreaDefaults}
        currentRoom="test-room"
        dmTarget={undefined}
      />,
    );
    expect(screen.getByText("test-room")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Leave" })).toBeInTheDocument();
  });

  it("renders header with DM target", () => {
    renderWithMantine(
      <ChatArea
        {...chatAreaDefaults}
        currentRoom={undefined}
        dmTarget="agent-1"
      />,
    );
    expect(screen.getByText("DM with agent-1")).toBeInTheDocument();
  });

  it("does not show leave button without active room", () => {
    renderWithMantine(
      <ChatArea
        {...chatAreaDefaults}
        currentRoom={undefined}
        dmTarget={undefined}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Leave" }),
    ).not.toBeInTheDocument();
  });

  it("renders input bar", () => {
    renderWithMantine(
      <ChatArea
        {...chatAreaDefaults}
        currentRoom={undefined}
        dmTarget={undefined}
      />,
    );
    expect(screen.getByLabelText("Message")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
  });
});

describe("Sidebar component", () => {
  it("renders rooms with active state", () => {
    renderWithMantine(
      <Sidebar
        rooms={[MOCK_ROOM]}
        agents={[]}
        currentRoom="r1"
        onJoinRoom={() => {}}
        {...SIDEBAR_DEFAULTS}
      />,
    );
    const roomLink = screen.getByText("Room 1 (2)");
    expect(roomLink).toBeInTheDocument();
  });

  it("renders agents with status dots", () => {
    renderWithMantine(
      <Sidebar
        rooms={[]}
        agents={[MOCK_AGENT]}
        currentRoom={undefined}
        onJoinRoom={() => {}}
        {...SIDEBAR_DEFAULTS}
      />,
    );
    expect(screen.getByText("Agent 1")).toBeInTheDocument();
  });

  it("renders empty agent list", () => {
    renderWithMantine(
      <Sidebar
        rooms={[]}
        agents={[]}
        currentRoom={undefined}
        onJoinRoom={() => {}}
        {...SIDEBAR_DEFAULTS}
      />,
    );
    expect(screen.queryByText("Agent 1")).not.toBeInTheDocument();
  });

  it("renders create room toggle button", () => {
    renderWithMantine(
      <Sidebar
        rooms={[]}
        agents={[]}
        currentRoom={undefined}
        onJoinRoom={() => {}}
        {...SIDEBAR_DEFAULTS}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Create room" }),
    ).toBeInTheDocument();
  });

  it("renders join room toggle button", () => {
    renderWithMantine(
      <Sidebar
        rooms={[]}
        agents={[]}
        currentRoom={undefined}
        onJoinRoom={() => {}}
        {...SIDEBAR_DEFAULTS}
      />,
    );
    expect(
      screen.getByRole("button", { name: "+ Join Room" }),
    ).toBeInTheDocument();
  });
});

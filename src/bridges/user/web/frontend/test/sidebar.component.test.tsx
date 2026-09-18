// @vitest-environment jsdom
/**
 * Component interaction tests for Sidebar.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sidebar } from "../components/Sidebar.js";
import type { Agent, Room } from "../types.js";
import { stubMantineJsdomGlobals } from "./jsdom-mantine-polyfills.js";
import { renderWithMantine } from "./render-with-mantine.js";

beforeEach(() => {
  stubMantineJsdomGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const MOCK_ROOM: Room = {
  id: "r1",
  name: "Room 1",
  type: "public",
  owner: "a",
  createdAt: "",
  description: "",
  members: ["a"],
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
  onRenameAgent: () => {},
};

describe("Sidebar interactions", () => {
  it("calls onJoinRoom when a room is clicked", async () => {
    const user = userEvent.setup();
    let joinedRoom: string | undefined;
    renderWithMantine(
      <Sidebar
        rooms={[MOCK_ROOM]}
        agents={[]}
        currentRoom={undefined}
        onJoinRoom={(id) => {
          joinedRoom = id;
        }}
        onSelectAgent={() => {}}
        onCreateRoom={() => {}}
        onJoinRoomInput={() => {}}
        {...SIDEBAR_DEFAULTS}
      />,
    );
    await user.click(screen.getByText("Room 1 (1)"));
    expect(joinedRoom).toBe("r1");
  });

  it("calls onSelectAgent when an agent is clicked", async () => {
    const user = userEvent.setup();
    let selectedAgent: string | undefined;
    renderWithMantine(
      <Sidebar
        rooms={[]}
        agents={[MOCK_AGENT]}
        currentRoom={undefined}
        onJoinRoom={() => {}}
        onSelectAgent={(id) => {
          selectedAgent = id;
        }}
        onCreateRoom={() => {}}
        onJoinRoomInput={() => {}}
        {...SIDEBAR_DEFAULTS}
      />,
    );
    await user.click(screen.getByText("Agent 1"));
    expect(selectedAgent).toBe("a1");
  });

  it("shows create room form when toggle is clicked", async () => {
    const user = userEvent.setup();
    renderWithMantine(
      <Sidebar
        rooms={[]}
        agents={[]}
        currentRoom={undefined}
        onJoinRoom={() => {}}
        onSelectAgent={() => {}}
        onCreateRoom={() => {}}
        onJoinRoomInput={() => {}}
        {...SIDEBAR_DEFAULTS}
      />,
    );

    expect(screen.queryByLabelText(/Room name/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create room" }));

    expect(screen.getByLabelText(/Room name/)).toBeInTheDocument();
  });

  it("hides create room form when cancel is clicked", async () => {
    const user = userEvent.setup();
    renderWithMantine(
      <Sidebar
        rooms={[]}
        agents={[]}
        currentRoom={undefined}
        onJoinRoom={() => {}}
        onSelectAgent={() => {}}
        onCreateRoom={() => {}}
        onJoinRoomInput={() => {}}
        {...SIDEBAR_DEFAULTS}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Create room" }));
    expect(screen.getByLabelText(/Room name/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText(/Room name/)).not.toBeInTheDocument();
  });

  it("shows join form when join toggle is clicked", async () => {
    const user = userEvent.setup();
    renderWithMantine(
      <Sidebar
        rooms={[]}
        agents={[]}
        currentRoom={undefined}
        onJoinRoom={() => {}}
        onSelectAgent={() => {}}
        onCreateRoom={() => {}}
        onJoinRoomInput={() => {}}
        {...SIDEBAR_DEFAULTS}
      />,
    );

    expect(screen.queryByLabelText(/Room name/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "+ Join Room" }));

    expect(screen.getByLabelText(/Room name/)).toBeInTheDocument();
  });

  it("renders multiple rooms", () => {
    const rooms: Room[] = [
      MOCK_ROOM,
      { ...MOCK_ROOM, id: "r2", name: "Room 2" },
      { ...MOCK_ROOM, id: "r3", name: "Room 3" },
    ];
    renderWithMantine(
      <Sidebar
        rooms={rooms}
        agents={[]}
        currentRoom={undefined}
        onJoinRoom={() => {}}
        onSelectAgent={() => {}}
        onCreateRoom={() => {}}
        onJoinRoomInput={() => {}}
        {...SIDEBAR_DEFAULTS}
      />,
    );
    for (const room of rooms) {
      expect(screen.getByText(`${room.name} (1)`)).toBeInTheDocument();
    }
  });

  it("renders multiple agents", () => {
    const agents: Agent[] = [
      MOCK_AGENT,
      { ...MOCK_AGENT, id: "a2", name: "Agent 2" },
    ];
    renderWithMantine(
      <Sidebar
        rooms={[]}
        agents={agents}
        currentRoom={undefined}
        onJoinRoom={() => {}}
        onSelectAgent={() => {}}
        onCreateRoom={() => {}}
        onJoinRoomInput={() => {}}
        {...SIDEBAR_DEFAULTS}
      />,
    );
    for (const agent of agents) {
      expect(screen.getByText(agent.name)).toBeInTheDocument();
    }
  });
});

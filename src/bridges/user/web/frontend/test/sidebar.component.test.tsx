/**
 * Component interaction tests for Sidebar.
 *
 * Uses Preact's act() to flush state updates after clicks.
 */

import { describe, it, expect } from "vitest";
import { render as preactRender } from "preact";
import { act } from "preact/test-utils";
import { Window } from "happy-dom";
import { Sidebar } from "../components/Sidebar.js";
import type { Agent, Room } from "../types.js";

let windowRef: Window | undefined;

function setup(): { container: HTMLElement; cleanup: () => void } {
  windowRef = new Window();
  const doc = (windowRef as unknown as { document: Document }).document;
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
  collapsed: false,
  onRenameAgent: () => {},
};

describe("Sidebar interactions", () => {
  it("calls onJoinRoom when a room is clicked", () => {
    const { container, cleanup } = setup();
    try {
      let joinedRoom: string | undefined;
      preactRender(
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
        container,
      );
      const roomItem = container.querySelector(".room-item") as HTMLElement;
      roomItem.click();
      expect(joinedRoom).toBe("r1");
    } finally {
      cleanup();
    }
  });

  it("calls onSelectAgent when an agent is clicked", () => {
    const { container, cleanup } = setup();
    try {
      let selectedAgent: string | undefined;
      preactRender(
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
        container,
      );
      const agentItem = container.querySelector(".agent-item") as HTMLElement;
      agentItem.click();
      expect(selectedAgent).toBe("a1");
    } finally {
      cleanup();
    }
  });

  it("shows create room form when toggle is clicked", () => {
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
          {...SIDEBAR_DEFAULTS}
        />,
        container,
      );

      expect(container.querySelector("form")).toBe(null);

      act(() => {
        const toggle = container.querySelector(
          "#create-room-toggle",
        ) as HTMLElement;
        toggle.click();
      });

      expect(
        container.querySelector("form.create-room-form"),
        "create room form should appear after toggle click",
      ).toBeTruthy();
    } finally {
      cleanup();
    }
  });

  it("hides create room form when cancel is clicked", () => {
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
          {...SIDEBAR_DEFAULTS}
        />,
        container,
      );

      // Show form
      act(() => {
        const toggle = container.querySelector(
          "#create-room-toggle",
        ) as HTMLElement;
        toggle.click();
      });
      expect(container.querySelector("form")).toBeTruthy();

      // Cancel
      act(() => {
        const cancel = container.querySelector(
          ".create-room-cancel",
        ) as HTMLElement;
        cancel.click();
      });

      expect(container.querySelector("form")).toBe(null);
    } finally {
      cleanup();
    }
  });

  it("shows join form when join toggle is clicked", () => {
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
          {...SIDEBAR_DEFAULTS}
        />,
        container,
      );

      expect(container.querySelector("input.join-input")).toBe(null);

      act(() => {
        const toggle = container.querySelector(
          "#join-toggle-btn",
        ) as HTMLElement;
        toggle.click();
      });

      expect(
        container.querySelector("input.join-input"),
        "join input should appear after toggle click",
      ).toBeTruthy();
    } finally {
      cleanup();
    }
  });

  it("renders multiple rooms", () => {
    const { container, cleanup } = setup();
    try {
      const rooms: Room[] = [
        MOCK_ROOM,
        { ...MOCK_ROOM, id: "r2", name: "Room 2" },
        { ...MOCK_ROOM, id: "r3", name: "Room 3" },
      ];
      preactRender(
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
        container,
      );
      expect(container.querySelectorAll(".room-item").length).toBe(
        rooms.length,
      );
    } finally {
      cleanup();
    }
  });

  it("renders multiple agents", () => {
    const { container, cleanup } = setup();
    try {
      const agents: Agent[] = [
        MOCK_AGENT,
        { ...MOCK_AGENT, id: "a2", name: "Agent 2" },
      ];
      preactRender(
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
        container,
      );
      expect(container.querySelectorAll(".agent-item").length).toBe(2);
    } finally {
      cleanup();
    }
  });
});

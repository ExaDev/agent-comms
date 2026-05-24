/**
 * Component interaction tests for Sidebar.
 *
 * Uses Preact's act() to flush state updates after clicks.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
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
        />,
        container,
      );
      const roomItem = container.querySelector(".room-item") as HTMLElement;
      roomItem.click();
      assert.strictEqual(joinedRoom, "r1");
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
        />,
        container,
      );
      const agentItem = container.querySelector(".agent-item") as HTMLElement;
      agentItem.click();
      assert.strictEqual(selectedAgent, "a1");
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
        />,
        container,
      );

      assert.strictEqual(container.querySelector("form"), null);

      act(() => {
        const toggle = container.querySelector(
          "#create-room-toggle",
        ) as HTMLElement;
        toggle.click();
      });

      assert.ok(
        container.querySelector("form.create-room-form"),
        "create room form should appear after toggle click",
      );
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
      assert.ok(container.querySelector("form"));

      // Cancel
      act(() => {
        const cancel = container.querySelector(
          ".create-room-cancel",
        ) as HTMLElement;
        cancel.click();
      });

      assert.strictEqual(container.querySelector("form"), null);
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
        />,
        container,
      );

      assert.strictEqual(container.querySelector("input.join-input"), null);

      act(() => {
        const toggle = container.querySelector(
          "#join-toggle-btn",
        ) as HTMLElement;
        toggle.click();
      });

      assert.ok(
        container.querySelector("input.join-input"),
        "join input should appear after toggle click",
      );
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
        />,
        container,
      );
      assert.strictEqual(container.querySelectorAll(".room-item").length, 3);
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
        />,
        container,
      );
      assert.strictEqual(container.querySelectorAll(".agent-item").length, 2);
    } finally {
      cleanup();
    }
  });

  it("hides offline agents by default", () => {
    const { container, cleanup } = setup();
    try {
      const agents: Agent[] = [
        MOCK_AGENT,
        { ...MOCK_AGENT, id: "a2", name: "Agent 2", status: "offline" },
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
        />,
        container,
      );
      assert.strictEqual(container.querySelectorAll(".agent-item").length, 1);
    } finally {
      cleanup();
    }
  });

  it("shows offline agents when toggle is clicked", () => {
    const { container, cleanup } = setup();
    try {
      const agents: Agent[] = [
        MOCK_AGENT,
        { ...MOCK_AGENT, id: "a2", name: "Agent 2", status: "offline" },
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
        />,
        container,
      );
      // Offline agent hidden by default
      assert.strictEqual(container.querySelectorAll(".agent-item").length, 1);

      // Click toggle to show offline
      act(() => {
        const toggle = qs(container, "#toggle-offline-btn");
        toggle.click();
      });

      assert.strictEqual(
        container.querySelectorAll(".agent-item").length,
        2,
        "both agents visible after toggle",
      );
    } finally {
      cleanup();
    }
  });

  it("re-hides offline agents when toggle is clicked again", () => {
    const { container, cleanup } = setup();
    try {
      const agents: Agent[] = [
        MOCK_AGENT,
        { ...MOCK_AGENT, id: "a2", name: "Agent 2", status: "offline" },
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
        />,
        container,
      );

      // Show offline
      act(() => {
        const toggle = qs(container, "#toggle-offline-btn");
        toggle.click();
      });
      assert.strictEqual(container.querySelectorAll(".agent-item").length, 2);

      // Hide offline again
      act(() => {
        const toggle = qs(container, "#toggle-offline-btn");
        toggle.click();
      });
      assert.strictEqual(container.querySelectorAll(".agent-item").length, 1);
    } finally {
      cleanup();
    }
  });
});

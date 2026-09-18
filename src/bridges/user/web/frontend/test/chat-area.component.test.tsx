// @vitest-environment jsdom
/**
 * Component interaction tests for ChatArea.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatArea } from "../components/ChatArea.js";
import type { DisplayMessage } from "../types.js";
import { stubMantineJsdomGlobals } from "./jsdom-mantine-polyfills.js";
import { renderWithMantine } from "./render-with-mantine.js";

beforeEach(() => {
  stubMantineJsdomGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const chatAreaDefaults = {
  sidebarOpened: true,
  onToggleSidebar: () => {},
  onSendAction: () => {},
  onLeaveRoom: () => {},
  onConnectToMesh: () => {},
};

describe("ChatArea interactions", () => {
  it("calls onLeaveRoom when leave button is clicked", async () => {
    const user = userEvent.setup();
    let leftCalled = false;
    renderWithMantine(
      <ChatArea
        {...chatAreaDefaults}
        messages={[]}
        currentRoom="room-1"
        dmTarget={undefined}
        connected={true}
        onLeaveRoom={() => {
          leftCalled = true;
        }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Leave" }));
    expect(leftCalled).toBe(true);
  });

  it("does not render leave button when no room is active", () => {
    renderWithMantine(
      <ChatArea
        {...chatAreaDefaults}
        messages={[]}
        currentRoom={undefined}
        dmTarget={undefined}
        connected={true}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Leave" }),
    ).not.toBeInTheDocument();
  });

  it("renders send button", () => {
    renderWithMantine(
      <ChatArea
        {...chatAreaDefaults}
        messages={[]}
        currentRoom={undefined}
        dmTarget={undefined}
        connected={true}
      />,
    );
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
  });

  it("renders messages", () => {
    const messages: DisplayMessage[] = [
      {
        type: "chat",
        sender: "A",
        content: "Hi",
        timestamp: "2025-05-23T14:30:45Z",
      },
      { type: "system", text: "Joined" },
    ];
    renderWithMantine(
      <ChatArea
        {...chatAreaDefaults}
        messages={messages}
        currentRoom="r1"
        dmTarget={undefined}
        connected={true}
      />,
    );
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(screen.getByText("Joined")).toBeInTheDocument();
  });

  // -----------------------------------------------------------------------
  // Connect prompt — deferred mesh connection UI
  // -----------------------------------------------------------------------

  it("renders connect prompt when disconnected with no messages", () => {
    renderWithMantine(
      <ChatArea
        {...chatAreaDefaults}
        messages={[]}
        currentRoom={undefined}
        dmTarget={undefined}
        connected={false}
      />,
    );
    expect(
      screen.getByText("Connect to a local mesh to discover agents and rooms."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Connect to local mesh" }),
    ).toBeInTheDocument();
  });

  it("does not render connect prompt when connected", () => {
    renderWithMantine(
      <ChatArea
        {...chatAreaDefaults}
        messages={[]}
        currentRoom={undefined}
        dmTarget={undefined}
        connected={true}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Connect to local mesh" }),
    ).not.toBeInTheDocument();
  });

  it("does not render connect prompt when disconnected but messages exist", () => {
    const messages: DisplayMessage[] = [
      { type: "system", text: "Previous session" },
    ];
    renderWithMantine(
      <ChatArea
        {...chatAreaDefaults}
        messages={messages}
        currentRoom={undefined}
        dmTarget={undefined}
        connected={false}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Connect to local mesh" }),
    ).not.toBeInTheDocument();
  });

  it("calls onConnectToMesh when connect button is clicked", async () => {
    const user = userEvent.setup();
    let connectCalled = false;
    renderWithMantine(
      <ChatArea
        {...chatAreaDefaults}
        messages={[]}
        currentRoom={undefined}
        dmTarget={undefined}
        connected={false}
        onConnectToMesh={() => {
          connectCalled = true;
        }}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Connect to local mesh" }),
    );
    expect(connectCalled).toBe(true);
  });
});

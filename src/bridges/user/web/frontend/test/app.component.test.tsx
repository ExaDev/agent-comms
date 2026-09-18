// @vitest-environment jsdom
/**
 * Component tests for App — the Chat/Mesh main-view switcher (agent-comms#201).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App, type AppProps } from "../components/App.js";
import { stubMantineJsdomGlobals } from "./jsdom-mantine-polyfills.js";
import { renderWithMantine } from "./render-with-mantine.js";

beforeEach(() => {
  stubMantineJsdomGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const APP_DEFAULTS: AppProps = {
  rooms: [],
  agents: [],
  currentRoom: undefined,
  dmTarget: undefined,
  messages: [],
  connected: true,
  meshGraph: undefined,
  onJoinRoom: () => {},
  onSelectAgent: () => {},
  onRenameAgent: () => {},
  onLeaveRoom: () => {},
  onSendAction: () => {},
  onCreateRoom: () => {},
  onJoinRoomInput: () => {},
  onConnectToMesh: () => {},
};

describe("App main-view switcher", () => {
  it("shows the chat area by default", () => {
    renderWithMantine(<App {...APP_DEFAULTS} />);
    expect(
      screen.getByPlaceholderText("Type a message or /command..."),
    ).toBeInTheDocument();
  });

  it("switches to the mesh panel when the Mesh segment is clicked", async () => {
    const user = userEvent.setup();
    renderWithMantine(<App {...APP_DEFAULTS} />);
    await user.click(screen.getByText("Mesh"));
    expect(
      screen.getByText("Mesh graph is not available on this connection."),
    ).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText("Type a message or /command..."),
    ).not.toBeInTheDocument();
  });
});

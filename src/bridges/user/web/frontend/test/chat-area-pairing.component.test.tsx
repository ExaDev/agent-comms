// @vitest-environment jsdom
/**
 * The hosted dashboard of a browser that was never paired shows how to pair and offers no connection to a bridge that would refuse it.
 */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { ChatArea } from "../components/ChatArea.js";
import { stubMantineJsdomGlobals } from "./jsdom-mantine-polyfills.js";
import { renderWithMantine } from "./render-with-mantine.js";

beforeEach(() => {
  stubMantineJsdomGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const props = {
  rooms: [],
  sidebarOpened: true,
  messages: [],
  currentRoom: undefined,
  dmTarget: undefined,
  connected: false,
  onToggleSidebar: () => undefined,
  onSendAction: () => undefined,
  onLeaveRoom: () => undefined,
  onConnectToMesh: () => undefined,
};

it("shows how to pair, and not the plain connect offer, when the browser is not paired", () => {
  renderWithMantine(<ChatArea {...props} pairingNeeded={true} />);

  expect(screen.getByText("Pair this browser with your bridge")).toBeTruthy();
  expect(screen.getByRole("link").getAttribute("href")).toContain("/pair");
  expect(screen.queryByText("Connect to local mesh")).toBeNull();
});

it("tells the person to update a bridge that predates pairing, since such a bridge has no pairing page", () => {
  renderWithMantine(<ChatArea {...props} pairingNeeded={true} />);

  expect(
    screen.getByText(/older than pairing: update agent-comms/),
  ).toBeTruthy();
});

it("shows the plain connect offer when the browser is paired", () => {
  renderWithMantine(<ChatArea {...props} pairingNeeded={false} />);

  expect(screen.getByText("Connect to local mesh")).toBeTruthy();
  expect(screen.queryByText("Pair this browser with your bridge")).toBeNull();
});

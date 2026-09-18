// @vitest-environment jsdom
/**
 * Component tests for MeshGraphView.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MeshGraphView } from "../components/MeshGraphView.js";
import type { MeshGraph } from "../types.js";
import { stubMantineJsdomGlobals } from "./jsdom-mantine-polyfills.js";
import { renderWithMantine } from "./render-with-mantine.js";

beforeEach(() => {
  stubMantineJsdomGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A device-id is a hex-encoded SHA-256 hash: 32 bytes, 64 hex characters. */
const DEVICE_ID_HEX_LENGTH = 64;
const DEVICE_A = "a".repeat(DEVICE_ID_HEX_LENGTH);
const DEVICE_B = "b".repeat(DEVICE_ID_HEX_LENGTH);

const MOCK_GRAPH: MeshGraph = {
  nodes: [DEVICE_A, DEVICE_B],
  edges: [{ kind: "direct", from: DEVICE_A, to: DEVICE_B }],
};

describe("MeshGraphView", () => {
  it("shows an empty-state message when the graph has no nodes", () => {
    renderWithMantine(
      <MeshGraphView
        graph={{ nodes: [], edges: [] }}
        selectedDevice={undefined}
        onSelectDevice={() => {}}
      />,
    );
    expect(
      screen.getByText("No known devices in the mesh graph."),
    ).toBeInTheDocument();
  });

  it("renders a node per device and an edge per connection", () => {
    renderWithMantine(
      <MeshGraphView
        graph={MOCK_GRAPH}
        selectedDevice={undefined}
        onSelectDevice={() => {}}
      />,
    );
    expect(
      screen.getByRole("img", { name: "Mesh connection graph" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: `Device ${DEVICE_A}` }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: `Device ${DEVICE_B}` }),
    ).toBeInTheDocument();
  });

  it("calls onSelectDevice when a node is clicked", async () => {
    const user = userEvent.setup();
    let selected: string | undefined;
    renderWithMantine(
      <MeshGraphView
        graph={MOCK_GRAPH}
        selectedDevice={undefined}
        onSelectDevice={(id) => {
          selected = id;
        }}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: `Device ${DEVICE_A}` }),
    );
    expect(selected).toBe(DEVICE_A);
  });
});

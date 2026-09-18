// @vitest-environment jsdom
/**
 * Component tests for MeshPanel — tab switching plus the trace request lifecycle.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MeshPanel } from "../components/MeshPanel.js";
import type { MeshGraph, MeshTraceResult } from "../types.js";
import { stubMantineJsdomGlobals } from "./jsdom-mantine-polyfills.js";
import { renderWithMantine } from "./render-with-mantine.js";

const fetchMeshTraceMock =
  vi.fn<(target: string) => Promise<MeshTraceResult>>();

vi.mock("../api.js", () => ({
  fetchMeshTrace: async (target: string) => fetchMeshTraceMock(target),
}));

beforeEach(() => {
  stubMantineJsdomGlobals();
  fetchMeshTraceMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A device-id is a hex-encoded SHA-256 hash: 32 bytes, 64 hex characters. */
const DEVICE_ID_HEX_LENGTH = 64;
/** Length of the truncated device-id hex label MeshGraphView/MeshTraceView show -- matches their own LABEL_HEX_LENGTH constant. */
const LABEL_HEX_LENGTH = 8;
const DEVICE_A = "a".repeat(DEVICE_ID_HEX_LENGTH);
const DEVICE_B = "b".repeat(DEVICE_ID_HEX_LENGTH);

const MOCK_GRAPH: MeshGraph = {
  nodes: [DEVICE_A, DEVICE_B],
  edges: [{ kind: "direct", from: DEVICE_A, to: DEVICE_B }],
};

describe("MeshPanel", () => {
  it("shows an unavailable message when the graph is undefined", () => {
    renderWithMantine(<MeshPanel graph={undefined} />);
    expect(
      screen.getByText("Mesh graph is not available on this connection."),
    ).toBeInTheDocument();
  });

  it("shows the graph tab by default", () => {
    renderWithMantine(<MeshPanel graph={MOCK_GRAPH} />);
    expect(
      screen.getByRole("img", { name: "Mesh connection graph" }),
    ).toBeInTheDocument();
  });

  it("switches to the trace tab and traces a node selected from the graph", async () => {
    const user = userEvent.setup();
    fetchMeshTraceMock.mockResolvedValue({
      rttMs: 5,
      local: { relayed: false },
      outcome: { result: "ok" },
    });
    renderWithMantine(<MeshPanel graph={MOCK_GRAPH} />);

    await user.click(
      screen.getByRole("button", { name: `Device ${DEVICE_A}` }),
    );
    await user.click(screen.getByRole("tab", { name: "Trace" }));
    await user.click(screen.getByRole("button", { name: "Trace" }));

    await waitFor(() => {
      expect(screen.getByText("5ms round trip")).toBeInTheDocument();
    });
    expect(fetchMeshTraceMock).toHaveBeenCalledWith(DEVICE_A);
  });

  it("shows an error when the trace request fails", async () => {
    const user = userEvent.setup();
    fetchMeshTraceMock.mockRejectedValue(new Error("device unreachable"));
    renderWithMantine(<MeshPanel graph={MOCK_GRAPH} />);

    await user.click(screen.getByRole("tab", { name: "Trace" }));
    await user.click(screen.getByRole("combobox", { name: "Target device" }));
    await user.click(
      await screen.findByRole("option", {
        name: DEVICE_A.slice(0, LABEL_HEX_LENGTH),
      }),
    );
    await user.click(screen.getByRole("button", { name: "Trace" }));

    await waitFor(() => {
      expect(screen.getByText("device unreachable")).toBeInTheDocument();
    });
  });
});

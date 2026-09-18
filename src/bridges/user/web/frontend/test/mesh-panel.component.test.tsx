// @vitest-environment jsdom
/**
 * Component tests for MeshPanel — tab switching plus the trace request lifecycle, now driven by real TanStack Query hooks (agent-comms#206) rather than a mocked fetch client. Builds a real queryUtils object via createTanstackQueryUtils over a mocked reads client, the same way MeshClient itself does, so the test exercises the real query/mutation wiring rather than reimplementing it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { MeshPanel } from "../components/MeshPanel.js";
import type { MeshGraph, MeshTraceResult } from "../types.js";
import { stubMantineJsdomGlobals } from "./jsdom-mantine-polyfills.js";
import { renderWithMantine } from "./render-with-mantine.js";

const getMeshGraphMock = vi.fn<() => Promise<MeshGraph>>();
const getMeshTraceMock =
  vi.fn<
    (
      input: Readonly<{ target: string; timeoutMs?: number }>,
    ) => Promise<MeshTraceResult>
  >();

const queryUtils = createTanstackQueryUtils({
  getMeshGraph: async () => getMeshGraphMock(),
  getMeshTrace: async (
    input: Readonly<{ target: string; timeoutMs?: number }>,
  ) => getMeshTraceMock(input),
});

beforeEach(() => {
  stubMantineJsdomGlobals();
  getMeshGraphMock.mockReset();
  getMeshTraceMock.mockReset();
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
  it("shows an unavailable message while the graph query has no data", () => {
    getMeshGraphMock.mockReturnValue(new Promise(() => {}));
    renderWithMantine(<MeshPanel queryUtils={queryUtils} />);
    expect(
      screen.getByText("Mesh graph is not available on this connection."),
    ).toBeInTheDocument();
  });

  it("shows the graph tab once the query resolves", async () => {
    getMeshGraphMock.mockResolvedValue(MOCK_GRAPH);
    renderWithMantine(<MeshPanel queryUtils={queryUtils} />);
    expect(
      await screen.findByRole("img", { name: "Mesh connection graph" }),
    ).toBeInTheDocument();
  });

  it("switches to the trace tab and traces a node selected from the graph", async () => {
    const user = userEvent.setup();
    getMeshGraphMock.mockResolvedValue(MOCK_GRAPH);
    getMeshTraceMock.mockResolvedValue({
      rttMs: 5,
      local: { relayed: false },
      outcome: { result: "ok" },
    });
    renderWithMantine(<MeshPanel queryUtils={queryUtils} />);

    await user.click(
      await screen.findByRole("button", { name: `Device ${DEVICE_A}` }),
    );
    await user.click(screen.getByRole("tab", { name: "Trace" }));
    await user.click(screen.getByRole("button", { name: "Trace" }));

    await waitFor(() => {
      expect(screen.getByText("5ms round trip")).toBeInTheDocument();
    });
    expect(getMeshTraceMock).toHaveBeenCalledWith({ target: DEVICE_A });
  });

  it("shows an error when the trace request fails", async () => {
    const user = userEvent.setup();
    getMeshGraphMock.mockResolvedValue(MOCK_GRAPH);
    getMeshTraceMock.mockRejectedValue(new Error("device unreachable"));
    renderWithMantine(<MeshPanel queryUtils={queryUtils} />);

    await user.click(await screen.findByRole("tab", { name: "Trace" }));
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

// @vitest-environment jsdom
/**
 * Component tests for MeshTraceView.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MeshTraceView } from "../components/MeshTraceView.js";
import type { MeshTraceResult } from "../types.js";
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

const VIEW_DEFAULTS = {
  targets: [DEVICE_A],
  selectedTarget: undefined,
  onSelectTarget: () => {},
  onTrace: () => {},
  loading: false,
  error: undefined,
  result: undefined,
};

describe("MeshTraceView", () => {
  it("disables the Trace button until a target is selected", () => {
    renderWithMantine(<MeshTraceView {...VIEW_DEFAULTS} />);
    expect(screen.getByRole("button", { name: "Trace" })).toBeDisabled();
  });

  it("calls onTrace when Trace is clicked with a target selected", async () => {
    const user = userEvent.setup();
    let traced = false;
    renderWithMantine(
      <MeshTraceView
        {...VIEW_DEFAULTS}
        selectedTarget={DEVICE_A}
        onTrace={() => {
          traced = true;
        }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Trace" }));
    expect(traced).toBe(true);
  });

  it("shows the error message when one is present", () => {
    renderWithMantine(
      <MeshTraceView {...VIEW_DEFAULTS} error="device unreachable" />,
    );
    expect(screen.getByText("device unreachable")).toBeInTheDocument();
  });

  it("shows a direct, successful result", () => {
    const result: MeshTraceResult = {
      rttMs: 12,
      local: { relayed: false },
      outcome: { result: "ok" },
    };
    renderWithMantine(<MeshTraceView {...VIEW_DEFAULTS} result={result} />);
    expect(screen.getByText("ok")).toBeInTheDocument();
    expect(screen.getByText("12ms round trip")).toBeInTheDocument();
    expect(screen.getByText("Local: direct")).toBeInTheDocument();
  });

  it("shows a relayed result with hub addresses on both sides", () => {
    const result: MeshTraceResult = {
      rttMs: 40,
      local: { relayed: true, hubAddress: "wss://hub.example" },
      remote: { relayed: true, hubAddress: "wss://hub.example" },
      outcome: { result: "ok" },
    };
    renderWithMantine(<MeshTraceView {...VIEW_DEFAULTS} result={result} />);
    expect(
      screen.getByText("Local: relayed via wss://hub.example"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Remote: relayed via wss://hub.example"),
    ).toBeInTheDocument();
  });

  it("shows an error outcome's code as the badge", () => {
    const result: MeshTraceResult = {
      rttMs: 0,
      local: { relayed: false },
      outcome: { result: "error", code: "not_connected" },
    };
    renderWithMantine(<MeshTraceView {...VIEW_DEFAULTS} result={result} />);
    expect(screen.getByText("not_connected")).toBeInTheDocument();
  });
});

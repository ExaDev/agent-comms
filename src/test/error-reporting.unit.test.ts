/**
 * Unit tests for createMeshErrorReporter -- the default sink for a mesh store's error channel in the bridges that have no UI of their own.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createMeshErrorReporter,
  formatMeshError,
} from "../core/error-reporting.js";

describe("formatMeshError", () => {
  it("reports an error as one prefixed, newline-terminated line", () => {
    expect(formatMeshError(new Error("listen EADDRINUSE"))).toBe(
      "agent-comms: listen EADDRINUSE\n",
    );
  });
});

describe("createMeshErrorReporter", () => {
  it("writes each error to the sink as one prefixed line", () => {
    const write = vi.fn<(line: string) => void>();
    const report = createMeshErrorReporter(write);

    report(new Error("listen EADDRINUSE"));
    report(new Error("hub unreachable"));

    expect(write.mock.calls).toEqual([
      ["agent-comms: listen EADDRINUSE\n"],
      ["agent-comms: hub unreachable\n"],
    ]);
  });

  it("writes to the real process stderr by default", () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      createMeshErrorReporter()(new Error("boom"));
      expect(stderr).toHaveBeenCalledWith("agent-comms: boom\n");
    } finally {
      stderr.mockRestore();
    }
  });
});

/**
 * The mesh error reporter's default sink. Everything else about error reporting is in the conformance corpus (conformance/function/error-reporting.json); this stays here because it observes the real process stderr.
 */
import { describe, expect, it, vi } from "vitest";
import { createMeshErrorReporter } from "../core/error-reporting.js";

describe("createMeshErrorReporter", () => {
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

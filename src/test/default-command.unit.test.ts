/**
 * Unit tests for resolveDefaultCommand (agent-comms#339): a bare `agent-comms` picks setup or the MCP server from whether stdin is a terminal, and never reinterprets an explicit subcommand.
 */
import { describe, expect, it } from "vitest";
import { resolveDefaultCommand } from "../core/default-command.js";

describe("resolveDefaultCommand", () => {
  it("serves the generic MCP bridge for a bare command whose stdin is not a terminal", () => {
    expect(resolveDefaultCommand([], false)).toEqual(["bridge", "mcp"]);
  });

  it("leaves a bare command on a terminal to the setup default", () => {
    expect(resolveDefaultCommand([], true)).toEqual([]);
  });

  it.each([
    [["setup"], false],
    [["status"], false],
    [["remove"], false],
    [["bridge", "claude-code"], false],
    [["bridge", "mcp"], false],
    [["send", "room", "hello"], false],
    [["setup"], true],
    [["bridge", "codex"], true],
  ] as const)(
    "returns the explicit subcommand %j untouched when stdin is a terminal: %s",
    (args, stdinIsTerminal) => {
      expect(resolveDefaultCommand(args, stdinIsTerminal)).toEqual(args);
    },
  );
});

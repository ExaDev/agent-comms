import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  CLAUDE_COMM_SHELL_PATTERNS,
  isClaudeCodeComm,
} from "../bridges/claude-code/claudeCommand.js";

describe("isClaudeCodeComm", () => {
  it.each([
    "claude",
    "/opt/homebrew/Caskroom/claude-code/2.1.311/claude",
    "/Users/example/.local/bin/claude",
    "/Users/example/.local/share/claude/versions/2.1.322",
  ])("accepts %s", (comm) => {
    expect(isClaudeCodeComm(comm)).toBe(true);
  });

  it.each([
    "node",
    "-zsh",
    "tmux",
    "/usr/bin/claude-notification",
    "/Users/example/.local/share/claude/versions/notes",
    "/Users/example/.local/share/claude/versions/2.1.322/helper",
  ])("rejects %s", (comm) => {
    expect(isClaudeCodeComm(comm)).toBe(false);
  });
});

describe("hooks/drain.sh", () => {
  it("matches the process forms the bridge matches", () => {
    const script = readFileSync(
      new URL("../../hooks/drain.sh", import.meta.url),
      "utf8",
    );
    expect(script).toContain(`${CLAUDE_COMM_SHELL_PATTERNS}) echo`);
  });
});

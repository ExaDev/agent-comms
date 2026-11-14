import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { CLAUDE_COMM_SHELL_PATTERNS } from "../bridges/claude-code/claudeCommand.js";

// The cases for isClaudeCodeComm itself are in the conformance corpus (conformance/function/claude-command.json). This stays here because it reads a file of this repository.
describe("hooks/drain.sh", () => {
  it("matches the process forms the bridge matches", () => {
    const script = readFileSync(
      new URL("../../hooks/drain.sh", import.meta.url),
      "utf8",
    );
    expect(script).toContain(`${CLAUDE_COMM_SHELL_PATTERNS}) echo`);
  });
});

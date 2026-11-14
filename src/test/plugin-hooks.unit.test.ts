import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { z } from "zod";

// Claude Code's plugin hooks file wraps the event map in a top-level "hooks" key; a file holding only the event map fails to load and no hook runs (https://code.claude.com/docs/en/plugins-reference#hooks).
const commandHook = z.object({
  type: z.literal("command"),
  command: z.string(),
  timeout: z.number().optional(),
  asyncRewake: z.boolean().optional(),
});
const matcherGroup = z.object({
  matcher: z.string(),
  hooks: z.array(commandHook).min(1),
});
const hooksFile = z
  .object({ hooks: z.record(z.string(), z.array(matcherGroup).min(1)) })
  .strict();

async function readHooksFile(): Promise<unknown> {
  const text = await readFile(
    new URL("../../hooks/hooks.json", import.meta.url),
    "utf8",
  );
  return JSON.parse(text);
}

describe("hooks/hooks.json", () => {
  it("wraps the event map in the top-level hooks key Claude Code requires", async () => {
    const parsed = hooksFile.safeParse(await readHooksFile());
    expect(parsed.error?.issues ?? []).toEqual([]);
  });

  it("registers the drain script for every event that delivers pending messages", async () => {
    const file = hooksFile.parse(await readHooksFile());
    expect(Object.keys(file.hooks).sort()).toEqual([
      "PostToolUse",
      "Stop",
      "UserPromptSubmit",
    ]);
    for (const groups of Object.values(file.hooks)) {
      for (const group of groups) {
        for (const hook of group.hooks) {
          expect(hook.command).toBe("${CLAUDE_PLUGIN_ROOT}/hooks/drain.sh");
        }
      }
    }
  });
});

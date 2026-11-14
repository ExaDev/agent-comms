import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
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
          expect(hook.command).toBe('"${CLAUDE_PLUGIN_ROOT}"/hooks/drain.sh');
        }
      }
    }
  });
});

const pluginManifest = z.object({
  hooks: z.unknown().optional(),
  mcpServers: z.record(
    z.string(),
    z.object({ command: z.string(), args: z.array(z.string()) }),
  ),
});

const projectMcpConfig = z.object({
  mcpServers: z.record(
    z.string(),
    z.object({ command: z.string(), args: z.array(z.string()) }),
  ),
});

async function readJson(relative: string): Promise<unknown> {
  return JSON.parse(
    await readFile(new URL(`../../${relative}`, import.meta.url), "utf8"),
  );
}

describe("the plugin's files", () => {
  it("ships drain.sh as an executable file in git", () => {
    const entry = execFileSync("git", ["ls-files", "-s", "hooks/drain.sh"], {
      cwd: new URL("../../", import.meta.url),
      encoding: "utf8",
    });
    expect(entry.startsWith("100755 ")).toBe(true);
  });

  it("does not declare hooks/hooks.json in the manifest, which Claude Code already loads from that default path", async () => {
    const manifest = pluginManifest.parse(
      await readJson(".claude-plugin/plugin.json"),
    );
    expect(manifest.hooks).toBeUndefined();
  });

  it("runs the published package as the plugin's MCP server, whatever the checkout's own .mcp.json says", async () => {
    const manifest = pluginManifest.parse(
      await readJson(".claude-plugin/plugin.json"),
    );
    expect(manifest.mcpServers["agent-comms"]).toEqual({
      command: "npx",
      args: ["agent-comms", "bridge", "claude-code"],
    });
  });

  it("keeps any absolute path out of the checkout's .mcp.json", async () => {
    const config = projectMcpConfig.parse(await readJson(".mcp.json"));
    for (const server of Object.values(config.mcpServers)) {
      for (const part of [server.command, ...server.args]) {
        expect(part).not.toMatch(/^(\/|~|[A-Za-z]:[\\/])/);
      }
    }
  });
});

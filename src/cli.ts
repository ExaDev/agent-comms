/**
 * agent-comms — cross-harness LLM agent communication mesh.
 *
 * Usage:
 *   npx agent-comms              # setup (auto-detect and configure)
 *   npx agent-comms setup        # same as above
 *   npx agent-comms status       # check current configuration
 *   npx agent-comms remove       # undo configuration
 *   npx agent-comms bridge <id>  # run a bridge (used by harness configs)
 *   npx agent-comms chat         # interactive TUI (web UI auto-starts)
 *   npx agent-comms send <room> <message>   # one-shot send
 *   npx agent-comms dm <agent> <message>     # one-shot DM
 *   npx agent-comms rooms                     # list rooms
 *   npx agent-comms agents                    # list agents
 *   npx agent-comms read <room>               # read room messages
 *
 * The bridge subcommand lets harnesses invoke the bridge via npx:
 *   .mcp.json:  \{ "command": "npx", "args": ["agent-comms", "bridge", "claude-code"] \}
 *   config.toml: command = "npx", args = ["agent-comms", "bridge", "codex"]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { z } from "zod";
import { bridges } from "./bridges/registry.js";
import { runTui } from "./bridges/user/tui.js";
import { runCli } from "./bridges/user/cli.js";

// ---------------------------------------------------------------------------
// Zod schemas for config files
// ---------------------------------------------------------------------------

const PiSettingsSchema = z
  .object({
    extensions: z.array(z.string()).optional(),
  })
  .loose();

const McpServersSchema = z
  .object({
    mcpServers: z
      .record(
        z.string(),
        z
          .object({
            command: z.string(),
            args: z.array(z.string()).optional(),
          })
          .loose(),
      )
      .default({}),
  })
  .loose();

const OpenCodeConfigSchema = z
  .object({
    plugin: z.array(z.string()).optional(),
  })
  .loose();

// ---------------------------------------------------------------------------
// Config I/O
// ---------------------------------------------------------------------------

function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return undefined;
  }
}

function writeJsonFile(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
  console.log(`  → Wrote ${filePath}`);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOME = os.homedir();
const PKG_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CheckResult {
  configured: boolean;
  details: string[];
}

interface HarnessDef {
  id: string;
  detect: () => boolean;
  configure: () => void;
  remove: () => void;
  check: () => CheckResult;
}

// ---------------------------------------------------------------------------
// Harness definitions
// ---------------------------------------------------------------------------

const harnesses: HarnessDef[] = [
  {
    id: "pi",
    detect: () => fs.existsSync(path.join(HOME, ".pi", "agent", "extensions")),
    configure: () => {
      configurePi();
    },
    remove: () => {
      removePi();
    },
    check: () => checkPi(),
  },
  {
    id: "claude-code",
    detect: () => {
      try {
        execSync("which claude", { stdio: "pipe" });
        return true;
      } catch {
        return false;
      }
    },
    configure: () => {
      configureClaudeCode();
    },
    remove: () => {
      removeClaudeCode();
    },
    check: () => checkClaudeCode(),
  },
  {
    id: "codex",
    detect: () => {
      try {
        execSync("which codex", { stdio: "pipe" });
        return true;
      } catch {
        return false;
      }
    },
    configure: () => {
      configureCodex();
    },
    remove: () => {
      removeCodex();
    },
    check: () => checkCodex(),
  },
  {
    id: "opencode",
    detect: () => {
      try {
        execSync("which opencode", { stdio: "pipe" });
        return true;
      } catch {
        return false;
      }
    },
    configure: () => {
      configureOpenCode();
    },
    remove: () => {
      removeOpenCode();
    },
    check: () => checkOpenCode(),
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// process.argv[0] is the node binary, [1] the script path, [2] the subcommand -- everything from here on is the subcommand's own args.
const CLI_ARGS_START_INDEX = 3;

const command = process.argv[2] ?? "setup";

switch (command) {
  case "setup":
    setup();
    break;
  case "status":
    status();
    break;
  case "remove":
    remove();
    break;
  case "bridge": {
    const bridgeId = process.argv[3];
    if (bridgeId === undefined) {
      console.error("Usage: agent-comms bridge <id>");
      process.exit(1);
    }
    runBridge(bridgeId);
    break;
  }
  case "chat": {
    const chatArgs = process.argv.slice(CLI_ARGS_START_INDEX);
    runChat(chatArgs);
    break;
  }
  case "send":
  case "dm":
  case "rooms":
  case "agents":
  case "read": {
    const cliArgs = process.argv.slice(CLI_ARGS_START_INDEX);
    runUserCli(command, cliArgs);
    break;
  }
  default:
    console.log(
      "Usage: agent-comms [setup|status|remove|bridge <id>|chat|send|dm|rooms|agents|read]",
    );
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Bridge runner
// ---------------------------------------------------------------------------

function runBridge(id: string): void {
  const bridge = bridges[id];
  if (!bridge) {
    console.error(
      `Unknown bridge: ${id}. Available: ${Object.keys(bridges).join(", ")}`,
    );
    process.exit(1);
  }
  Promise.resolve(bridge.run()).catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}

function parseNameArg(args: readonly string[]): {
  name: string;
  rest: readonly string[];
} {
  const nameIdx = args.indexOf("--name");
  if (nameIdx !== -1) {
    const val = args[nameIdx + 1];
    if (val !== undefined) {
      return {
        name: val,
        rest: [...args.slice(0, nameIdx), ...args.slice(nameIdx + 2)],
      };
    }
  }
  return { name: "Joe", rest: args };
}

function runChat(args: readonly string[]): void {
  const { name } = parseNameArg(args);
  runTui(name).catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}

function runUserCli(cliCommand: string, args: readonly string[]): void {
  const { name, rest } = parseNameArg(args);
  runCli(cliCommand, rest, name).catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function setup(): void {
  console.log("🔌 Agent Comms setup\n");

  const detected = harnesses.filter((h) => h.detect());

  console.log("Detected harnesses:");
  for (const h of harnesses) {
    console.log(`  ${detected.includes(h) ? "✓" : "✗"} ${h.id}`);
  }

  if (detected.length === 0) {
    console.log(
      "\nNo supported harnesses found. Install one of: pi, Claude Code, Codex, OpenCode",
    );
    process.exit(1);
  }

  console.log();

  for (const h of detected) {
    console.log(`Configuring ${h.id}...`);
    h.configure();
  }

  const plural = detected.length === 1 ? "" : "es";
  console.log(
    `\n✓ Done! ${String(detected.length)} harness${plural} configured.`,
  );
  console.log("\nBridges run via: npx agent-comms bridge <id>");
}

function status(): void {
  console.log("🔌 Agent Comms status\n");

  for (const h of harnesses) {
    const installed = h.detect();
    const result = installed
      ? h.check()
      : { configured: false, details: Array<string>() };

    if (!installed) {
      console.log(`  ✗ ${h.id} — not found`);
    } else if (result.configured) {
      console.log(`  ✓ ${h.id} — configured`);
      for (const detail of result.details) console.log(`    ${detail}`);
    } else {
      console.log(`  ⚠ ${h.id} — detected but not configured`);
      for (const detail of result.details) console.log(`    ${detail}`);
    }
  }
}

function remove(): void {
  console.log("🔌 Agent Comms removal\n");

  for (const h of harnesses) {
    if (h.detect()) {
      console.log(`Removing ${h.id}...`);
      h.remove();
    }
  }

  console.log("\n✓ Done!");
}

// ---------------------------------------------------------------------------
// pi
// ---------------------------------------------------------------------------

function configurePi(): void {
  const settingsPath = path.join(HOME, ".pi", "agent", "settings.json");
  const parsed = readJsonFile(settingsPath);
  const settings = PiSettingsSchema.parse(parsed ?? {});

  const bridgeDir = path.join(PKG_DIR, "src", "bridges", "pi");
  const extensions = settings.extensions ?? [];

  if (!extensions.includes(bridgeDir)) {
    extensions.push(bridgeDir);
    settings.extensions = extensions;
    writeJsonFile(settingsPath, settings);
  } else {
    console.log(`  → Already in ${settingsPath}`);
  }
}

function removePi(): void {
  const settingsPath = path.join(HOME, ".pi", "agent", "settings.json");
  const parsed = readJsonFile(settingsPath);
  const settings = PiSettingsSchema.parse(parsed ?? {});

  const extensions = settings.extensions;

  if (extensions) {
    settings.extensions = extensions.filter((e: string) => {
      const segments = e.toLowerCase().split("/");
      const busIdx = segments.indexOf("bridges");
      return !(
        busIdx !== -1 &&
        segments[busIdx + 1] === "pi" &&
        e.toLowerCase().includes("agent-comms")
      );
    });
    writeJsonFile(settingsPath, settings);
  }
}

function checkPi(): CheckResult {
  const settingsPath = path.join(HOME, ".pi", "agent", "settings.json");
  const parsed = readJsonFile(settingsPath);
  const settings = PiSettingsSchema.parse(parsed ?? {});
  const bridgeDir = path.join(PKG_DIR, "src", "bridges", "pi");
  const configured = (settings.extensions ?? []).includes(bridgeDir);
  return {
    configured,
    details: configured
      ? [`Extension: ${bridgeDir}`]
      : [`Not in ${settingsPath} extensions`],
  };
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

function configureClaudeCode(): void {
  const mcpPath = path.join(process.cwd(), ".mcp.json");
  const parsed = readJsonFile(mcpPath);
  const config = McpServersSchema.parse(parsed ?? {});

  config.mcpServers["agent-comms"] = {
    command: "npx",
    args: ["agent-comms", "bridge", "claude-code"],
  };

  writeJsonFile(mcpPath, config);
}

function removeClaudeCode(): void {
  const mcpPath = path.join(process.cwd(), ".mcp.json");
  const parsed = readJsonFile(mcpPath);
  if (parsed === undefined) return;
  const config = McpServersSchema.safeParse(parsed);
  if (!config.success) return;
  if ("agent-comms" in config.data.mcpServers) {
    delete config.data.mcpServers["agent-comms"];
    writeJsonFile(mcpPath, config.data);
    console.log(`  Removed agent-comms from ${mcpPath}`);
  }
}

function checkClaudeCode(): CheckResult {
  const mcpPath = path.join(process.cwd(), ".mcp.json");
  const parsed = readJsonFile(mcpPath);
  const config = McpServersSchema.safeParse(parsed ?? {});
  const entry = config.success
    ? config.data.mcpServers["agent-comms"]
    : undefined;
  const configured = entry !== undefined;
  return {
    configured,
    details: configured
      ? [`Config: ${mcpPath}`, `Command: ${entry.command}`]
      : [`Not in ${mcpPath}`],
  };
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

function configureCodex(): void {
  const configDir = path.join(HOME, ".codex");

  // Add MCP server to config.toml
  const tomlPath = path.join(configDir, "config.toml");
  if (fs.existsSync(tomlPath)) {
    const content = fs.readFileSync(tomlPath, "utf-8");
    if (!content.includes("agent-comms")) {
      const block = [
        "",
        "# Agent Comms MCP tool server",
        "[mcp_servers.agent-comms]",
        'command = "npx"',
        'args = ["agent-comms", "bridge", "codex"]',
      ].join("\n");
      fs.writeFileSync(tomlPath, content.trimEnd() + block + "\n");
      console.log(`  → Appended MCP server to ${tomlPath}`);
    } else {
      console.log(`  → Already in ${tomlPath}`);
    }
  } else {
    const content = [
      "# Agent Comms MCP tool server",
      "[mcp_servers.agent-comms]",
      'command = "npx"',
      'args = ["agent-comms", "bridge", "codex"]',
    ].join("\n");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(tomlPath, content + "\n");
    console.log(`  → Created ${tomlPath}`);
  }
}

function removeCodex(): void {
  const configDir = path.join(HOME, ".codex");

  // Remove from config.toml
  const tomlPath = path.join(configDir, "config.toml");
  if (fs.existsSync(tomlPath)) {
    const content = fs.readFileSync(tomlPath, "utf-8");
    const lines = content
      .split("\n")
      .filter(
        (line) =>
          !line.includes("agent-comms") && !line.includes("Agent Comms"),
      );
    fs.writeFileSync(tomlPath, lines.join("\n").trimEnd() + "\n");
    console.log(`  Removed agent-comms from ${tomlPath}`);
  }
}

function checkCodex(): CheckResult {
  const details: string[] = [];
  const tomlPath = path.join(HOME, ".codex", "config.toml");
  if (fs.existsSync(tomlPath)) {
    const content = fs.readFileSync(tomlPath, "utf-8");
    const tomlOk = content.includes("agent-comms");
    details.push(tomlOk ? `MCP server in ${tomlPath}` : `Not in ${tomlPath}`);
    return { configured: tomlOk, details };
  }
  details.push(`${tomlPath} not found`);
  return { configured: false, details };
}

// ---------------------------------------------------------------------------
// OpenCode
// ---------------------------------------------------------------------------

function configureOpenCode(): void {
  const configPath = path.join(process.cwd(), "opencode.json");
  const parsed = readJsonFile(configPath);
  const config = OpenCodeConfigSchema.parse(parsed ?? {});

  const bridgeDir = path.join(
    PKG_DIR,
    "src",
    "bridges",
    "opencode",
    "plugin.ts",
  );
  const plugins = config.plugin ?? [];

  if (!plugins.includes(bridgeDir)) {
    plugins.push(bridgeDir);
    config.plugin = plugins;
    writeJsonFile(configPath, config);
  } else {
    console.log(`  → Already in ${configPath}`);
  }
}

function removeOpenCode(): void {
  const configPath = path.join(process.cwd(), "opencode.json");
  const parsed = readJsonFile(configPath);
  if (parsed === undefined) return;
  const config = OpenCodeConfigSchema.safeParse(parsed);
  if (!config.success) return;
  const bridgeDir = path.join(
    PKG_DIR,
    "src",
    "bridges",
    "opencode",
    "plugin.ts",
  );
  const plugins = config.data.plugin;
  if (plugins) {
    config.data.plugin = plugins.filter((p: string) => p !== bridgeDir);
    writeJsonFile(configPath, config.data);
    console.log(`  Removed agent-comms from ${configPath}`);
  }
}

function checkOpenCode(): CheckResult {
  const configPath = path.join(process.cwd(), "opencode.json");
  const parsed = readJsonFile(configPath);
  const config = OpenCodeConfigSchema.safeParse(parsed ?? {});
  const bridgeDir = path.join(
    PKG_DIR,
    "src",
    "bridges",
    "opencode",
    "plugin.ts",
  );
  const configured =
    config.success && (config.data.plugin ?? []).includes(bridgeDir);
  return {
    configured,
    details: configured ? [`Plugin: ${bridgeDir}`] : [`Not in ${configPath}`],
  };
}

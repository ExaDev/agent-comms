import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  INITIAL_RETRY_DELAY_MS,
  MAX_TOTAL_RETRY_MS,
  isNpmPropagationLag,
  nextRetryDelayMs,
} from "../src/core/mcp-registry-retry.js";

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

function sleepSync(ms: number): void {
  spawnSync("sleep", [String(ms / 1000)]);
}

function runPublishWithRetry(command: string, args: string[]): void {
  const deadline = Date.now() + MAX_TOTAL_RETRY_MS;
  let delayMs = INITIAL_RETRY_DELAY_MS;
  for (let attempt = 1; ; attempt++) {
    const result = spawnSync(command, args, { encoding: "utf8" });
    if (result.status === 0) {
      process.stdout.write(result.stdout);
      return;
    }
    const output = `${result.stdout}${result.stderr}`;
    const canRetry =
      isNpmPropagationLag(output) && Date.now() + delayMs < deadline;
    if (canRetry) {
      console.error(
        `mcp-publisher publish hit npm propagation lag (attempt ${String(attempt)}), retrying in ${String(delayMs / 1000)}s`,
      );
      sleepSync(delayMs);
      delayMs = nextRetryDelayMs(delayMs);
      continue;
    }
    process.stdout.write(output);
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

function binaryArchFor(arch: string): string {
  if (arch === "x64") return "amd64";
  if (arch === "arm64") return "arm64";
  throw new Error(`Unsupported architecture: ${arch}`);
}

function main(): void {
  const archiveUrl = `https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_${process.platform}_${binaryArchFor(process.arch)}.tar.gz`;
  const tempDir = mkdtempSync(path.join(tmpdir(), "agent-comms-mcp-"));

  try {
    run("bash", [
      "-lc",
      `curl -fsSL "${archiveUrl}" | tar -xzf - -C "${tempDir}" mcp-publisher`,
    ]);
    run(path.join(tempDir, "mcp-publisher"), ["login", "github-oidc"]);
    runPublishWithRetry(path.join(tempDir, "mcp-publisher"), ["publish"]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// Only run as a side effect when executed directly (semantic-release's own exec step), never on a plain import, which is how the test suite reaches nextRetryDelayMs()/isNpmPropagationLag() (via src/core/mcp-registry-retry.ts) without downloading mcp-publisher or attempting a real publish.
const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === `file://${invokedPath}`) {
  main();
}

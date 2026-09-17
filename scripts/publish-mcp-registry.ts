import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  INITIAL_RETRY_DELAY_MS,
  MAX_TOTAL_RETRY_MS,
  isRetryablePublishFailure,
  nextRetryDelayMs,
} from "../src/core/mcp-registry-retry.js";

const MS_PER_SECOND = 1000;

function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

function sleepSync(ms: number): void {
  spawnSync("sleep", [String(ms / MS_PER_SECOND)]);
}

// Re-runs the login step before every retry, not just the failure classes that need it, because it's the only way to make a retry of an expired-JWT 401 (see isExpiredJwt in src/core/mcp-registry-retry.ts) actually stand a chance: retrying with the same token that just 401'd would just 401 again. A fresh login before a propagation-lag/5xx/connection-error retry is harmless, so there's no need to special-case which failure triggered the retry.
function runPublishWithRetry(
  publisherPath: string,
  loginArgs: readonly string[],
  publishArgs: readonly string[],
): void {
  const deadline = Date.now() + MAX_TOTAL_RETRY_MS;
  let delayMs = INITIAL_RETRY_DELAY_MS;
  for (let attempt = 1; ; attempt++) {
    const result = spawnSync(publisherPath, publishArgs, { encoding: "utf8" });
    if (result.status === 0) {
      process.stdout.write(result.stdout);
      return;
    }
    const output = `${result.stdout}${result.stderr}`;
    const canRetry =
      isRetryablePublishFailure(output) && Date.now() + delayMs < deadline;
    if (canRetry) {
      console.error(
        `mcp-publisher publish hit a retryable failure (attempt ${String(attempt)}), retrying in ${String(delayMs / MS_PER_SECOND)}s`,
      );
      sleepSync(delayMs);
      run(publisherPath, loginArgs);
      delayMs = nextRetryDelayMs(delayMs);
      continue;
    }
    process.stdout.write(output);
    throw new Error(
      `Command failed: ${publisherPath} ${publishArgs.join(" ")}`,
    );
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
    const publisherPath = path.join(tempDir, "mcp-publisher");
    const loginArgs = ["login", "github-oidc"];
    run(publisherPath, loginArgs);
    runPublishWithRetry(publisherPath, loginArgs, ["publish"]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// Only run as a side effect when executed directly (semantic-release's own exec step), never on a plain import, which is how the test suite reaches nextRetryDelayMs()/isRetryablePublishFailure() (via src/core/mcp-registry-retry.ts) without downloading mcp-publisher or attempting a real publish.
const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === `file://${invokedPath}`) {
  main();
}

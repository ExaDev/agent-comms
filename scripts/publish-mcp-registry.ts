import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

// The MCP registry validates a publish against the npm registry, where the version semantic-release published seconds earlier may not be visible yet. The registry's own error text says to wait and retry, so retry that failure specifically instead of failing the release job on propagation lag.
//
// The previous fixed [15, 30, 60, 120] schedule (225s total) was observed to be too short: a real CI run hit npm propagation lag that outlasted it and failed the whole release job even though the npm publish itself had already succeeded. The release job carries no timeout-minutes of its own (.github/workflows/ci.yml), so there is no tight external deadline forcing a small budget -- retrying is bounded by MAX_TOTAL_RETRY_MS below purely so a genuinely broken publish (not just slow propagation) still fails within the same run rather than retrying for hours, not by any CI time pressure.
const MAX_TOTAL_RETRY_MS = 15 * 60 * 1000;
const INITIAL_RETRY_DELAY_MS = 15_000;
const MAX_RETRY_DELAY_MS = 120_000;
const RETRY_BACKOFF_MULTIPLIER = 2;

function isNpmPropagationLag(output: string): boolean {
  return (
    output.includes("was not found") &&
    output.includes("A newly published release can take a moment")
  );
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
      delayMs = Math.min(
        delayMs * RETRY_BACKOFF_MULTIPLIER,
        MAX_RETRY_DELAY_MS,
      );
      continue;
    }
    process.stdout.write(output);
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

const os = process.platform;
const arch = process.arch;

let binaryArch: string;
if (arch === "x64") {
  binaryArch = "amd64";
} else if (arch === "arm64") {
  binaryArch = "arm64";
} else {
  throw new Error(`Unsupported architecture: ${arch}`);
}

const archiveUrl = `https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_${os}_${binaryArch}.tar.gz`;
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

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
const PUBLISH_RETRY_DELAYS_SECONDS = [15, 30, 60, 120];

function isNpmPropagationLag(output: string): boolean {
  return (
    output.includes("was not found") &&
    output.includes("A newly published release can take a moment")
  );
}

function sleepSync(seconds: number): void {
  spawnSync("sleep", [String(seconds)]);
}

function runPublishWithRetry(command: string, args: string[]): void {
  for (let attempt = 1; ; attempt++) {
    const result = spawnSync(command, args, { encoding: "utf8" });
    if (result.status === 0) {
      process.stdout.write(result.stdout);
      return;
    }
    const output = `${result.stdout}${result.stderr}`;
    const retryDelay = PUBLISH_RETRY_DELAYS_SECONDS[attempt - 1];
    if (retryDelay !== undefined && isNpmPropagationLag(output)) {
      console.error(
        `mcp-publisher publish hit npm propagation lag (attempt ${String(attempt)}), retrying in ${String(retryDelay)}s`,
      );
      sleepSync(retryDelay);
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

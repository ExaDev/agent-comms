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
  run(path.join(tempDir, "mcp-publisher"), ["publish"]);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

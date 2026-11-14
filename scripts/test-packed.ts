/**
 * Runs the package as a consumer gets it: packs the tarball, installs it with its dependencies into an empty directory, runs the multi-process smoke test against that installed copy and starts its MCP bridge from the installed `dist/cli.js`. A module the package needs at run time but does not publish fails here.
 *
 * Usage: tsx scripts/test-packed.ts (after `pnpm build`).
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const work = mkdtempSync(join(tmpdir(), "agent-comms-packed-"));
try {
  const packed = execFileSync("npm", ["pack", "--pack-destination", work], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const tarball = join(
    work,
    readdirSync(work).find((name) => name.endsWith(".tgz")) ?? packed.trim(),
  );
  const consumer = join(work, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, "package.json"),
    '{"name":"consumer","version":"0.0.0","private":true}\n',
  );
  // pnpm, which the repository's own installs use, so the install honours the same release age and exclusions as everywhere else.
  execFileSync("pnpm", ["add", "--ignore-scripts", tarball], {
    cwd: consumer,
    stdio: "inherit",
  });
  const installed = join(consumer, "node_modules", "agent-comms");

  const smoke = spawnSync("tsx", ["--test", "src/test/mesh-smoke.runner.ts"], {
    stdio: "inherit",
    env: { ...process.env, AGENT_COMMS_PACKAGE_DIR: installed },
  });
  if (smoke.status !== 0) {
    throw new Error("the smoke test failed against the installed package");
  }

  const initialize = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "packed-check", version: "0" },
    },
  });
  const home = join(work, "home");
  const bridge = spawnSync(
    "node",
    [join(installed, "dist", "cli.js"), "bridge", "mcp"],
    {
      input: `${initialize}\n`,
      encoding: "utf8",
      timeout: 20_000,
      killSignal: "SIGKILL",
      env: { ...process.env, HOME: home, USERPROFILE: home },
    },
  );
  if (!bridge.stdout.includes('"protocolVersion"')) {
    throw new Error(
      `the installed bridge did not answer initialize:\n${bridge.stdout}\n${bridge.stderr}`,
    );
  }
  console.log(
    "the installed package passed the smoke test and answered initialize",
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}

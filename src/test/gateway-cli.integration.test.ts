/**
 * The real `agent-comms gateway redeem` process refuses when stdin is not a terminal, and trusts nothing: the code is never read from a pipe.
 */

import { spawn } from "node:child_process";
import * as path from "node:path";
import { expect, it } from "vitest";
import { GatewayTrust } from "../core/gateway-trust.js";
import { ConnectionCodeLedger } from "../core/connection-code.js";
import { scratchDirectory } from "./scratch-directory.helper.js";

const TEST_TIMEOUT_MS = 60_000;
/** A device-id is 32 bytes. */
const DEVICE_ID_BYTES = 32;
const DEVICE = "cd".repeat(DEVICE_ID_BYTES);

it(
  "exits non-zero with its reason when the code and a yes are piped in, and trusts nothing",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const dir = scratchDirectory("agent-comms-gateway-cli-process-");
    const code = await new ConnectionCodeLedger().generate(DEVICE);
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx/esm",
        path.join(import.meta.dirname, "..", "cli.ts"),
        "gateway",
        "redeem",
      ],
      {
        env: { ...process.env, AGENT_COMMS_DATA_DIR: dir },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.stdin.end(`${JSON.stringify(code)}\nyes\n`);
    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("exit", resolve);
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain("needs a terminal");
    expect(new GatewayTrust({ location: { dataDir: dir } }).list()).toEqual([]);
  },
);

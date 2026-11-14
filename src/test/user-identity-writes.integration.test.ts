/**
 * Several processes updating one account file at once keep each other's updates: every read-modify-write of the file runs under its write lock.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test } from "vitest";
import {
  loadOrCreateUserIdentity,
  readLegacyIssuedGrants,
} from "../core/user-identity.js";
import { scratchDirectory } from "./scratch-directory.helper.js";

const WORKER_SCRIPT = path.join(
  import.meta.dirname,
  "user-identity-write-worker.ts",
);
const WORKER_COUNT = 8;
const GRANTS_PER_WORKER = 25;
/** Time for every worker's own start-up to finish before the shared deadline. */
const START_DELAY_MS = 1500;
const TEST_TIMEOUT_MS = 60_000;

async function runWorker(
  dir: string,
  index: number,
  startAt: number,
): Promise<{ exitCode: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx/esm",
        WORKER_SCRIPT,
        dir,
        String(index),
        String(startAt),
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", reject);
    child.on("exit", (exitCode) => {
      resolve({ exitCode, stderr });
    });
  });
}

test(
  "processes removing legacy grants from the account file at once lose none of the removals",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const dir = scratchDirectory("agent-comms-user-identity-writes-");
    loadOrCreateUserIdentity({ dir });
    const file = path.join(dir, "user-identity.json");
    const record = JSON.parse(fs.readFileSync(file, "utf-8")) as object;
    const grants: Record<string, string> = {};
    for (let worker = 0; worker < WORKER_COUNT; worker++) {
      for (let n = 0; n < GRANTS_PER_WORKER; n++) {
        grants[`worker-${String(worker)}-${String(n)}`] = Buffer.from(
          `token-${String(worker)}-${String(n)}`,
        ).toString("base64");
      }
    }
    fs.writeFileSync(
      file,
      JSON.stringify({ ...record, issuedDmGrants: grants }),
    );

    const startAt = Date.now() + START_DELAY_MS;
    const results = await Promise.all(
      Array.from({ length: WORKER_COUNT }, async (_, index) =>
        runWorker(dir, index, startAt),
      ),
    );

    expect(results.filter((r) => r.exitCode !== 0)).toEqual([]);
    expect(readLegacyIssuedGrants({ dir })).toEqual([]);
  },
);

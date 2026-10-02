/**
 * agent-comms#344: several real processes appending to one machine's account ledger at once, the way several bridges on a machine share its writer log, must each get a sequence number of their own. Two appends that both believed they held the cross-process lock would read the same head and write the same sequence number, and one grant would be lost.
 */

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { afterEach, expect, test } from "vitest";
import { createSystemClock } from "wire-mesh-core/adapters/system-clock";
import { openAccountLedger } from "../core/account-ledger-store.js";
import { loadOrCreateUserIdentity } from "../core/user-identity.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = path.join(__dirname, "account-ledger-lock-worker.ts");

/** Gives every worker's Node and tsx startup time to finish before the shared start, so they contend for the lock rather than run one after another. */
const START_DELAY_MS = 1500;
/** Enough processes contending that a lock released and re-claimed between another process's failed claim and its stale check happens many times per run. */
const WORKER_COUNT = 8;
/** Each append releases and re-claims the lock, so many short appends per worker maximise the churn the race needs. */
const APPENDS_PER_WORKER = 100;
/** Headroom over the start delay for the workers' own appends. */
const TIMEOUT_HEADROOM_MS = 30_000;
const SUBJECT = "lock-worker-bearer";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function runWorker(dir: string, startAt: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx/esm",
        WORKER_SCRIPT,
        dir,
        SUBJECT,
        String(APPENDS_PER_WORKER),
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
      if (exitCode === 0) resolve(stderr);
      else reject(new Error(`worker exited ${String(exitCode)}:\n${stderr}`));
    });
  });
}

test(
  "concurrent processes appending to one machine's ledger lose no grant",
  { timeout: START_DELAY_MS + TIMEOUT_HEADROOM_MS },
  async () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "account-ledger-lock-"));
    dirs.push(dir);
    const userIdentityOptions = { dir };
    const userIdentity = loadOrCreateUserIdentity(userIdentityOptions);
    const open = async () =>
      openAccountLedger({
        userIdentityOptions,
        userIdentity,
        clock: createSystemClock(),
      });
    // Opening once first creates the machine's writer nonce, so every worker appends to the same writer log rather than racing to create it.
    await open();

    const startAt = Date.now() + START_DELAY_MS;
    await Promise.all(
      Array.from({ length: WORKER_COUNT }, async () => runWorker(dir, startAt)),
    );

    const grants = await (await open()).outstandingGrants("dm", SUBJECT);
    expect(grants).toHaveLength(WORKER_COUNT * APPENDS_PER_WORKER);
  },
);

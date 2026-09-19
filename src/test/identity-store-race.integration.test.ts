/**
 * agent-comms#222 -- two or more real processes sharing one identity slot (harness, cwd) racing loadOrCreateIdentity+saveRoomToken concurrently against a slot that has never been touched before must never throw or corrupt the persisted identity, mirroring several independent Playwright e2e workers each starting a ChatController against the same cwd-derived slot.
 */

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { test, expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = path.join(__dirname, "identity-store-race-worker.ts");

// How far into the future the shared start deadline is set, giving every spawned worker's own Node+tsx startup enough headroom to finish before the deadline arrives -- too short and slower workers would blow past the deadline and race the busy-wait instead of the identity slot, defeating the barrier's purpose.
const START_DELAY_MS = 600;
// Concurrent workers racing the same fresh slot per round -- high enough that, pre-fix, the race is hit reliably rather than occasionally.
const WORKER_COUNT = 12;
// Independent rounds, each against its own fresh slot dir, to guard against a single lucky/unlucky round misrepresenting how reliably the race reproduces.
const ROUND_COUNT = 5;
// Headroom added on top of the start delay, per round, for the vitest test timeout -- covers the workers' own busy-wait plus their actual identity-store work.
const PER_ROUND_TIMEOUT_HEADROOM_MS = 5000;

interface WorkerResult {
  exitCode: number | null;
  stderr: string;
}

async function runWorker(
  dir: string,
  harness: string,
  startAt: number,
): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx/esm", WORKER_SCRIPT, dir, harness, String(startAt)],
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

async function raceRound(): Promise<WorkerResult[]> {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "agent-comms-identity-race-"));
  const startAt = Date.now() + START_DELAY_MS;
  const workers = Array.from({ length: WORKER_COUNT }, async () =>
    runWorker(dir, "user", startAt),
  );
  return Promise.all(workers);
}

test(
  "concurrent processes racing a fresh identity slot never throw 'no identity persisted for this slot yet'",
  {
    timeout: (START_DELAY_MS + PER_ROUND_TIMEOUT_HEADROOM_MS) * ROUND_COUNT,
  },
  async () => {
    for (let round = 0; round < ROUND_COUNT; round++) {
      const results = await raceRound();
      const failures = results.filter((r) => r.exitCode !== 0);
      expect(
        failures,
        `round ${String(round)}: ${String(failures.length)}/${String(WORKER_COUNT)} workers failed:\n${failures.map((f) => f.stderr).join("\n")}`,
      ).toEqual([]);
    }
  },
);

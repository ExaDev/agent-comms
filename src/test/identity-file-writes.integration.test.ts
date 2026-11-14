/**
 * Several processes updating one account or machine identity file at once keep each other's updates: each public function that rewrites such a file runs its read-modify-write under the file's write lock. Every case pairs two kinds of writer on one file, in separate processes, and fails when either function stops taking the lock.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test } from "vitest";
import {
  loadMachineDisplayName,
  loadOrCreateMachineIdentity,
  machineIdentityFile,
} from "../core/machine-identity.js";
import {
  loadOrCreateLedgerWriterNonce,
  loadOrCreateUserIdentity,
  loadUserDisplayName,
  readLegacyIssuedGrants,
} from "../core/user-identity.js";
import { scratchDirectory } from "./scratch-directory.helper.js";

const WORKER_SCRIPT = path.join(
  import.meta.dirname,
  "identity-file-write-worker.ts",
);
/** Time for every worker's own start-up to finish before the shared deadline. */
const START_DELAY_MS = 1500;
const TEST_TIMEOUT_MS = 120_000;
const WORKERS_PER_KIND = 4;
const ROUNDS = 40;
const GRANTS_PER_WORKER = 25;
const NONCE_ROUNDS = 5;
const NONCE_WORKERS = 8;
const MACHINE_ROUNDS = 5;

interface WorkerOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

async function runWorker(
  mode: string,
  dir: string,
  index: number,
  startAt: number,
): Promise<WorkerOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx/esm",
        WORKER_SCRIPT,
        mode,
        dir,
        String(index),
        String(ROUNDS),
        String(startAt),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", reject);
    child.on("exit", (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });
  });
}

/** Runs one worker per entry of `modes` at once, entry i being worker i. */
async function race(
  dir: string,
  modes: readonly string[],
): Promise<WorkerOutcome[]> {
  const startAt = Date.now() + START_DELAY_MS;
  const outcomes = await Promise.all(
    modes.map(async (mode, index) => runWorker(mode, dir, index, startAt)),
  );
  expect(outcomes.filter((o) => o.exitCode !== 0)).toEqual([]);
  return outcomes;
}

/** An account file holding legacy grants for the first `workers` workers. */
function accountWithGrants(workers: number): string {
  const dir = scratchDirectory("agent-comms-identity-file-writes-");
  loadOrCreateUserIdentity({ dir });
  const file = path.join(dir, "user-identity.json");
  const record = JSON.parse(fs.readFileSync(file, "utf-8")) as object;
  const grants: Record<string, string> = {};
  for (let worker = 0; worker < workers; worker++) {
    for (let n = 0; n < GRANTS_PER_WORKER; n++) {
      grants[`worker-${String(worker)}-${String(n)}`] = Buffer.from(
        `token-${String(worker)}-${String(n)}`,
      ).toString("base64");
    }
  }
  fs.writeFileSync(file, JSON.stringify({ ...record, issuedDmGrants: grants }));
  return dir;
}

const clearers = Array.from({ length: WORKERS_PER_KIND }, () => "clear");

test(
  "loadOrCreateLedgerWriterNonce settles every concurrent first caller on one nonce",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    for (let round = 0; round < NONCE_ROUNDS; round++) {
      const dir = scratchDirectory("agent-comms-identity-file-nonce-");
      loadOrCreateUserIdentity({ dir });

      const outcomes = await race(
        dir,
        Array.from({ length: NONCE_WORKERS }, () => "nonce"),
      );

      const nonces = new Set(outcomes.map((o) => o.stdout.trim()));
      expect([...nonces]).toHaveLength(1);
    }
  },
);

test(
  "clearLegacyIssuedGrants and saveUserDisplayName lose neither the removals nor the name",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const dir = accountWithGrants(WORKERS_PER_KIND);

    await race(dir, [
      ...clearers,
      ...Array.from({ length: WORKERS_PER_KIND }, () => "name"),
    ]);

    expect(readLegacyIssuedGrants({ dir })).toEqual([]);
    expect(loadUserDisplayName({ dir })).toMatch(/^name-\d+-39$/);
  },
);

test(
  "clearLegacyIssuedGrants and importAccountKey lose neither the removals nor the imported name",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const dir = accountWithGrants(WORKERS_PER_KIND);

    await race(dir, [
      ...clearers,
      ...Array.from({ length: WORKERS_PER_KIND }, () => "import"),
    ]);

    expect(readLegacyIssuedGrants({ dir })).toEqual([]);
    expect(loadUserDisplayName({ dir })).toMatch(/^import-\d+-39$/);
  },
);

test(
  "saveMachineDisplayName and the renewal of a machine identity lose neither the name nor the renewal",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    for (let round = 0; round < MACHINE_ROUNDS; round++) {
      const dir = scratchDirectory("agent-comms-identity-file-machine-");
      loadOrCreateMachineIdentity({ dir });
      const file = machineIdentityFile({ dir });
      const record = JSON.parse(fs.readFileSync(file, "utf-8")) as object;
      const expired = new Date(0).toISOString();
      fs.writeFileSync(file, JSON.stringify({ ...record, expiresAt: expired }));

      await race(dir, [
        ...Array.from({ length: WORKERS_PER_KIND }, () => "machine-renew"),
        ...Array.from({ length: WORKERS_PER_KIND }, () => "machine-name"),
      ]);

      const after = JSON.parse(fs.readFileSync(file, "utf-8")) as {
        expiresAt: string;
      };
      expect(Date.parse(after.expiresAt)).toBeGreaterThan(Date.now());
      expect(loadMachineDisplayName({ dir })).toMatch(/^machine-\d+-39$/);
    }
  },
);

test("the nonce a first caller stored is the one every later caller reads", () => {
  const dir = scratchDirectory("agent-comms-identity-file-nonce-after-");
  loadOrCreateUserIdentity({ dir });
  const first = loadOrCreateLedgerWriterNonce({ dir }, () => Uint8Array.of(1));
  const second = loadOrCreateLedgerWriterNonce({ dir }, () => Uint8Array.of(2));
  expect(Buffer.from(second)).toEqual(Buffer.from(first));
});

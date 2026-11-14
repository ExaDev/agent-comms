/**
 * Every write to the account or machine identity file that an asynchronous caller makes waits for a held write lock on timers, so a running bridge keeps serving while another process holds it, and fails with a typed error once the wait budget is spent.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test } from "vitest";
import { generateWriterNonce } from "../core/account-ledger-crypto.js";
import {
  loadOrCreateMachineIdentity,
  machineIdentityFile,
  saveMachineDisplayName,
} from "../core/machine-identity.js";
import {
  WRITE_LOCK_TIMEOUT,
  WriteLockTimeoutError,
  writeLockFor,
} from "../core/pid-lock-file.js";
import {
  clearLegacyIssuedGrants,
  importAccountKey,
  loadOrCreateLedgerWriterNonce,
  loadOrCreateUserIdentity,
  readAccountContents,
  saveUserDisplayName,
} from "../core/user-identity.js";
import { spawnLiveProcess } from "./live-process.helper.js";
import { scratchDirectory } from "./scratch-directory.helper.js";

const TIMER_PROBE_MS = 100;
const TEST_TIMEOUT_MS = 30_000;

type Write = (dir: string) => Promise<unknown>;

const WRITES: readonly (readonly [string, string, Write])[] = [
  [
    "saveUserDisplayName",
    "user-identity.json",
    async (dir) => saveUserDisplayName({ dir }, "name"),
  ],
  [
    "loadOrCreateLedgerWriterNonce",
    "user-identity.json",
    async (dir) =>
      loadOrCreateLedgerWriterNonce({ dir }, () => generateWriterNonce()),
  ],
  [
    "clearLegacyIssuedGrants",
    "user-identity.json",
    async (dir) => clearLegacyIssuedGrants({ dir }, []),
  ],
  [
    "importAccountKey",
    "user-identity.json",
    async (dir) => importAccountKey({ dir }, readAccountContents({ dir })),
  ],
  [
    "saveMachineDisplayName",
    "machine-identity.json",
    async (dir) => saveMachineDisplayName({ dir }, "name"),
  ],
];

test.each(WRITES)(
  "%s waits on timers while a live process holds the write lock, then fails with a typed error",
  { timeout: TEST_TIMEOUT_MS },
  async (_name, fileName, write) => {
    const dir = scratchDirectory("agent-comms-write-wait-");
    loadOrCreateUserIdentity({ dir });
    loadOrCreateMachineIdentity({ dir });
    const file =
      fileName === "machine-identity.json"
        ? machineIdentityFile({ dir })
        : path.join(dir, fileName);
    const holder = spawnLiveProcess();
    fs.writeFileSync(writeLockFor(file), `${String(holder.pid)}\n`);
    let timerRanWhileWaiting = false;
    const probe = setTimeout(() => {
      timerRanWhileWaiting = true;
    }, TIMER_PROBE_MS);
    try {
      const failure: unknown = await write(dir).then(
        () => undefined,
        (err: unknown) => err,
      );

      expect(failure).toBeInstanceOf(WriteLockTimeoutError);
      expect(failure).toMatchObject({ code: WRITE_LOCK_TIMEOUT });
      expect(timerRanWhileWaiting).toBe(true);
    } finally {
      clearTimeout(probe);
      await holder.exit();
    }
  },
);

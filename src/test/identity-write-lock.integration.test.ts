/**
 * The write lock of an identity slot file: its name belongs to no other file, a lock left by a dead process is taken over, and a lock held by a live one fails the write with a typed error after a bounded wait without blocking the event loop.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  loadOrCreateIdentity,
  loadRoomTokens,
  releaseIdentityLock,
  saveRoomToken,
  type IdentitySlot,
} from "../core/identity-store.js";
import {
  WRITE_LOCK_TIMEOUT,
  WriteLockTimeoutError,
  writeLockFor,
} from "../core/pid-lock-file.js";
import type { CapabilityToken } from "wire-mesh-core/generated/protocol";
import { deadPid, spawnLiveProcess } from "./live-process.helper.js";
import { scratchDirectory } from "./scratch-directory.helper.js";

// Structurally valid stand-in: the store only serialises the byte-string fields.
const TOKEN: CapabilityToken = [
  Uint8Array.from([1]),
  {},
  null,
  Uint8Array.from([2]),
];
const TIMER_PROBE_MS = 100;
const TEST_TIMEOUT_MS = 30_000;

const slots: IdentitySlot[] = [];

afterEach(() => {
  for (const slot of slots.splice(0)) releaseIdentityLock(slot);
});

function slotIn(dir: string, cwd: string): IdentitySlot {
  const slot: IdentitySlot = { harness: "write-lock", cwd, dir };
  slots.push(slot);
  return slot;
}

function files(dir: string, suffix: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(suffix))
    .map((f) => path.join(dir, f));
}

test(
  "the write lock of one slot never shares a name with the slot lock of another, whatever the working directories are called",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const dir = scratchDirectory("agent-comms-write-lock-names-");
    // Working directories whose names are the first one's with the endings the lock files use.
    const quiet = slotIn(dir, "proj");
    const lookalikes = ["proj.write", "proj.json.write", "proj.write-lock"].map(
      (cwd) => slotIn(dir, cwd),
    );
    loadOrCreateIdentity(quiet);
    const holder = spawnLiveProcess();
    try {
      for (const lookalike of lookalikes) {
        loadOrCreateIdentity(lookalike);
        // Another live process holds the lookalike slot for as long as it runs.
        for (const lock of files(dir, ".lock")) {
          fs.writeFileSync(lock, `${String(holder.pid)}\n`);
        }
      }

      // A write to the quiet slot must not wait on any of those locks.
      await saveRoomToken(quiet, "room", TOKEN);

      expect(Object.keys(loadRoomTokens(quiet))).toEqual(["room"]);
    } finally {
      await holder.exit();
    }
  },
);

test("a write lock left by a process that has died is taken over", async () => {
  const dir = scratchDirectory("agent-comms-write-lock-dead-");
  const slot = slotIn(dir, "proj");
  loadOrCreateIdentity(slot);
  const [identityFile] = files(dir, ".json");
  if (identityFile === undefined) throw new Error("no identity file");
  fs.writeFileSync(writeLockFor(identityFile), `${String(await deadPid())}\n`);

  await saveRoomToken(slot, "room", TOKEN);

  expect(Object.keys(loadRoomTokens(slot))).toEqual(["room"]);
  expect(fs.existsSync(writeLockFor(identityFile))).toBe(false);
});

test(
  "a write lock held by a live process fails the write with a typed error after a bounded wait, leaving the event loop running",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const dir = scratchDirectory("agent-comms-write-lock-live-");
    const slot = slotIn(dir, "proj");
    loadOrCreateIdentity(slot);
    const [identityFile] = files(dir, ".json");
    if (identityFile === undefined) throw new Error("no identity file");
    const holder = spawnLiveProcess();
    fs.writeFileSync(writeLockFor(identityFile), `${String(holder.pid)}\n`);
    let timerRanWhileWaiting = false;
    const probe = setTimeout(() => {
      timerRanWhileWaiting = true;
    }, TIMER_PROBE_MS);
    try {
      const failure: unknown = await saveRoomToken(slot, "room", TOKEN).then(
        () => undefined,
        (err: unknown) => err,
      );

      expect(failure).toBeInstanceOf(WriteLockTimeoutError);
      expect(failure).toMatchObject({ code: WRITE_LOCK_TIMEOUT });
      // The wait was on timers, so a timer set before it fired during it.
      expect(timerRanWhileWaiting).toBe(true);
      expect(Object.keys(loadRoomTokens(slot))).toEqual([]);
    } finally {
      clearTimeout(probe);
      await holder.exit();
    }
  },
);

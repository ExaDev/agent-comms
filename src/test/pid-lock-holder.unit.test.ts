/**
 * Who a lock's recorded holder is: a lock is taken over only when its holder can be shown dead, so a holder on another host, a process that merely shares a recorded pid, and a process this one is not allowed to signal are never judged dead by pid alone.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  liveLockHolder,
  releaseLockFile,
  tryAcquireLock,
} from "../core/pid-lock-file.js";
import { processStartMarker } from "../core/process-start.js";
import { deadPid, spawnLiveProcess } from "./live-process.helper.js";
import { scratchDirectory } from "./scratch-directory.helper.js";

const NONCE_BYTES = 16;
const NONCE = "00".repeat(NONCE_BYTES);
/** pid 1 exists on every host this runs on and belongs to another user, so signalling it is refused rather than answered. */
const OTHER_USERS_PID = 1;

const held: string[] = [];

afterEach(() => {
  for (const lock of held.splice(0)) releaseLockFile(lock);
});

function lockWith(...lines: readonly string[]): string {
  const file = path.join(
    scratchDirectory("agent-comms-lock-holder-"),
    "slot.lock",
  );
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  held.push(file);
  return file;
}

test("a lock recorded by another host is not taken over, even when its pid names no process here", async () => {
  const dead = await deadPid();
  const lock = lockWith(String(dead), NONCE, `${os.hostname()}-elsewhere`, "x");

  expect(tryAcquireLock(lock)).toEqual({ acquired: false, heldBy: dead });
  expect(liveLockHolder(lock)).toBe(dead);
  expect(fs.readFileSync(lock, "utf-8")).toContain(
    `${os.hostname()}-elsewhere`,
  );
});

test("a lock whose pid now names a process that started at another time is taken over", () => {
  const holder = spawnLiveProcess();
  const lock = lockWith(
    String(holder.pid),
    NONCE,
    os.hostname(),
    "not-its-start",
  );
  try {
    expect(liveLockHolder(lock)).toBeUndefined();
    expect(tryAcquireLock(lock)).toEqual({ acquired: true });
  } finally {
    void holder.exit();
  }
});

test("a lock whose holder is alive and started when recorded is kept", async () => {
  const holder = spawnLiveProcess();
  try {
    const start = processStartMarker(holder.pid);
    expect(start).toBeDefined();
    const lock = lockWith(
      String(holder.pid),
      NONCE,
      os.hostname(),
      start ?? "",
    );

    expect(liveLockHolder(lock)).toBe(holder.pid);
    expect(tryAcquireLock(lock)).toEqual({
      acquired: false,
      heldBy: holder.pid,
    });
  } finally {
    await holder.exit();
  }
});

test("a lock whose holder is another user's process is not taken over", () => {
  const lock = lockWith(String(OTHER_USERS_PID), NONCE, os.hostname(), "");

  expect(liveLockHolder(lock)).toBe(OTHER_USERS_PID);
  expect(tryAcquireLock(lock)).toEqual({
    acquired: false,
    heldBy: OTHER_USERS_PID,
  });
});

test("a lock this process claims records its host and its own start marker", () => {
  const lock = path.join(
    scratchDirectory("agent-comms-lock-claim-"),
    "slot.lock",
  );
  held.push(lock);

  expect(tryAcquireLock(lock)).toEqual({ acquired: true });

  const [pid, nonce, host, start] = fs.readFileSync(lock, "utf-8").split("\n");
  expect(pid).toBe(String(process.pid));
  expect(nonce).toMatch(/^[0-9a-f]{32}$/);
  expect(host).toBe(os.hostname());
  expect(start).toBe(processStartMarker(process.pid));
});

test("releasing leaves a lock another host recorded with this process's pid", () => {
  const lock = lockWith(
    String(process.pid),
    NONCE,
    `${os.hostname()}-elsewhere`,
    "",
  );

  releaseLockFile(lock);

  expect(fs.existsSync(lock)).toBe(true);
});

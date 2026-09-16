/**
 * Unit tests for persistent bridge identity (core/identity-store).
 */

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { test, expect } from "vitest";
import {
  loadOrCreateIdentity,
  oplogDirFor,
  releaseIdentityLock,
  type IdentitySlot,
} from "../core/identity-store.js";

function tempSlot(harness: string): { slot: IdentitySlot; dir: string } {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "agent-comms-identity-test-"));
  return { slot: { harness, cwd: "/tmp/project", dir }, dir };
}

function slotFile(dir: string, suffix: string): string {
  const found = fs.readdirSync(dir).find((f) => f.endsWith(suffix));
  expect(found, `expected a ${suffix} file in ${dir}`).toBeDefined();
  if (found === undefined)
    throw new Error(`expected a ${suffix} file in ${dir}`);
  return path.join(dir, found);
}

function lockPid(lockFile: string): number {
  return Number.parseInt(fs.readFileSync(lockFile, "utf-8").trim(), 10);
}

/** A child process that stays alive until killed, for live-PID lock tests. */
function spawnLiveProcess(): { pid: number; exit: () => Promise<void> } {
  const child = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 60000)"],
    { stdio: "ignore" },
  );
  expect(child.pid).toBeDefined();
  if (child.pid === undefined)
    throw new Error("expected the spawned child to have a pid");
  return {
    pid: child.pid,
    exit: async () =>
      new Promise((resolve) => {
        child.kill("SIGKILL");
        child.on("exit", () => {
          resolve();
        });
      }),
  };
}

test("loadOrCreateIdentity persists and reloads the same key material", () => {
  const { slot, dir } = tempSlot("pi");
  const first = loadOrCreateIdentity(slot);
  const lockFile = slotFile(dir, ".lock");
  expect(lockPid(lockFile)).toBe(process.pid);

  const reloaded = loadOrCreateIdentity(slot);
  expect(reloaded.fingerprint).toBe(first.fingerprint);
  expect(reloaded.privateKey).toBe(first.privateKey);
  expect(reloaded.certificate).toBe(first.certificate);

  releaseIdentityLock(slot);
  expect(fs.existsSync(lockFile)).toBe(false);
});

// Offset (in milliseconds) from now used to write a stored identity's expiresAt just inside the renewal window, without it having already expired outright.
const NEAR_EXPIRY_OFFSET_MS = 1000;

// Mask isolating the permission bits from a stat mode's file-type bits.
const PERMISSION_BITS_MASK = 0o777;
// Expected owner-only read/write permission bits for a persisted identity file.
const OWNER_ONLY_RW_PERMISSIONS = 0o600;

test("identity file is created with owner-only permissions", () => {
  const { slot, dir } = tempSlot("claude-code");
  loadOrCreateIdentity(slot);
  const mode = fs.statSync(slotFile(dir, ".json")).mode & PERMISSION_BITS_MASK;
  expect(mode).toBe(OWNER_ONLY_RW_PERMISSIONS);
  releaseIdentityLock(slot);
});

test("a slot held by a live process yields an ephemeral identity", () => {
  const { slot, dir } = tempSlot("mcp");
  const owner = loadOrCreateIdentity(slot);
  const lockFile = slotFile(dir, ".lock");

  const holder = spawnLiveProcess();
  fs.writeFileSync(lockFile, `${String(holder.pid)}\n`);

  const loser = loadOrCreateIdentity(slot);
  expect(loser.fingerprint).not.toBe(owner.fingerprint);
  // The live holder's lock must not be clobbered by the ephemeral loser.
  expect(lockPid(lockFile)).toBe(holder.pid);

  void holder.exit();
  releaseIdentityLock(slot);
});

test("a stale lock from a dead process is taken over", async () => {
  const { slot, dir } = tempSlot("codex");
  const owner = loadOrCreateIdentity(slot);
  const lockFile = slotFile(dir, ".lock");

  const holder = spawnLiveProcess();
  fs.writeFileSync(lockFile, `${String(holder.pid)}\n`);
  await holder.exit();

  const successor = loadOrCreateIdentity(slot);
  expect(successor.fingerprint).toBe(owner.fingerprint);
  releaseIdentityLock(slot);
});

test("a near-expiry identity is renewed", () => {
  const { slot, dir } = tempSlot("opencode");
  const original = loadOrCreateIdentity(slot);

  const identityFile = slotFile(dir, ".json");
  const stored = JSON.parse(fs.readFileSync(identityFile, "utf-8")) as {
    expiresAt: string;
  };
  stored.expiresAt = new Date(Date.now() + NEAR_EXPIRY_OFFSET_MS).toISOString();
  fs.writeFileSync(identityFile, JSON.stringify(stored));

  const renewed = loadOrCreateIdentity(slot);
  expect(renewed.fingerprint).not.toBe(original.fingerprint);
  releaseIdentityLock(slot);
});

test("a near-expiry identity is renewed without rotating the device-id", () => {
  const { slot, dir } = tempSlot("gemini");
  const original = loadOrCreateIdentity(slot);

  const identityFile = slotFile(dir, ".json");
  const stored = JSON.parse(fs.readFileSync(identityFile, "utf-8")) as {
    expiresAt: string;
  };
  stored.expiresAt = new Date(Date.now() + NEAR_EXPIRY_OFFSET_MS).toISOString();
  fs.writeFileSync(identityFile, JSON.stringify(stored));

  const renewed = loadOrCreateIdentity(slot);
  expect(renewed.deviceId).toEqual(original.deviceId);
  expect(renewed.privateKey).toBe(original.privateKey);
  releaseIdentityLock(slot);
});

test("a corrupt identity file is regenerated", () => {
  const { slot, dir } = tempSlot("user");
  loadOrCreateIdentity(slot);
  fs.writeFileSync(slotFile(dir, ".json"), "{not json");

  const regenerated = loadOrCreateIdentity(slot);
  expect(regenerated.fingerprint).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2})+$/);
  releaseIdentityLock(slot);
});

test("oplogDirFor is a sibling directory of the identity file, distinct per (harness, cwd)", () => {
  const { slot, dir } = tempSlot("pi");
  const oplogDir = oplogDirFor(slot);
  expect(path.dirname(oplogDir)).toBe(dir);
  expect(oplogDir).not.toBe(dir);
  expect(oplogDirFor({ ...slot, cwd: "/tmp/other-project" })).not.toBe(
    oplogDir,
  );
  expect(oplogDirFor({ ...slot, harness: "claude-code" })).not.toBe(oplogDir);
});

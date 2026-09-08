/**
 * Unit tests for persistent bridge identity (core/identity-store).
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import {
  loadOrCreateIdentity,
  releaseIdentityLock,
  type IdentitySlot,
} from "../core/identity-store.js";

function tempSlot(harness: string): { slot: IdentitySlot; dir: string } {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "agent-comms-identity-test-"));
  return { slot: { harness, cwd: "/tmp/project", dir }, dir };
}

function slotFile(dir: string, suffix: string): string {
  const found = fs.readdirSync(dir).find((f) => f.endsWith(suffix));
  assert.ok(found !== undefined, `expected a ${suffix} file in ${dir}`);
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
  assert.ok(child.pid !== undefined);
  return {
    pid: child.pid,
    exit: () =>
      new Promise((resolve) => {
        child.kill("SIGKILL");
        child.on("exit", () => resolve());
      }),
  };
}

void test("loadOrCreateIdentity persists and reloads the same key material", () => {
  const { slot, dir } = tempSlot("pi");
  const first = loadOrCreateIdentity(slot);
  const lockFile = slotFile(dir, ".lock");
  assert.equal(lockPid(lockFile), process.pid);

  const reloaded = loadOrCreateIdentity(slot);
  assert.equal(reloaded.fingerprint, first.fingerprint);
  assert.equal(reloaded.privateKey, first.privateKey);
  assert.equal(reloaded.certificate, first.certificate);

  releaseIdentityLock(slot);
  assert.equal(fs.existsSync(lockFile), false);
});

void test("identity file is created with owner-only permissions", () => {
  const { slot, dir } = tempSlot("claude-code");
  loadOrCreateIdentity(slot);
  const mode = fs.statSync(slotFile(dir, ".json")).mode & 0o777;
  assert.equal(mode, 0o600);
  releaseIdentityLock(slot);
});

void test("a slot held by a live process yields an ephemeral identity", () => {
  const { slot, dir } = tempSlot("mcp");
  const owner = loadOrCreateIdentity(slot);
  const lockFile = slotFile(dir, ".lock");

  const holder = spawnLiveProcess();
  fs.writeFileSync(lockFile, `${String(holder.pid)}\n`);

  const loser = loadOrCreateIdentity(slot);
  assert.notEqual(loser.fingerprint, owner.fingerprint);
  // The live holder's lock must not be clobbered by the ephemeral loser.
  assert.equal(lockPid(lockFile), holder.pid);

  void holder.exit();
  releaseIdentityLock(slot);
});

void test("a stale lock from a dead process is taken over", async () => {
  const { slot, dir } = tempSlot("codex");
  const owner = loadOrCreateIdentity(slot);
  const lockFile = slotFile(dir, ".lock");

  const holder = spawnLiveProcess();
  fs.writeFileSync(lockFile, `${String(holder.pid)}\n`);
  await holder.exit();

  const successor = loadOrCreateIdentity(slot);
  assert.equal(successor.fingerprint, owner.fingerprint);
  releaseIdentityLock(slot);
});

void test("a near-expiry identity is renewed", () => {
  const { slot, dir } = tempSlot("opencode");
  const original = loadOrCreateIdentity(slot);

  const identityFile = slotFile(dir, ".json");
  const stored = JSON.parse(fs.readFileSync(identityFile, "utf-8")) as {
    expiresAt: string;
  };
  stored.expiresAt = new Date(Date.now() + 1000).toISOString();
  fs.writeFileSync(identityFile, JSON.stringify(stored));

  const renewed = loadOrCreateIdentity(slot);
  assert.notEqual(renewed.fingerprint, original.fingerprint);
  releaseIdentityLock(slot);
});

void test("a corrupt identity file is regenerated", () => {
  const { slot, dir } = tempSlot("user");
  loadOrCreateIdentity(slot);
  fs.writeFileSync(slotFile(dir, ".json"), "{not json");

  const regenerated = loadOrCreateIdentity(slot);
  assert.match(regenerated.fingerprint, /^[0-9A-F]{2}(:[0-9A-F]{2})+$/);
  releaseIdentityLock(slot);
});

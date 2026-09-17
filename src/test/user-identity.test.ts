/**
 * Unit tests for the persistent user-principal identity (core/user-identity).
 */

import * as fs from "node:fs";
import type * as FsModule from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, vi, afterEach } from "vitest";
import { loadOrCreateUserIdentity } from "../core/user-identity.js";
import { CERTIFICATE_VALIDITY_MS } from "../core/identity.js";

// node:fs's writeFileSync is wrapped (not replaced) so every test gets the real filesystem by default; only the one race test below overrides it, via mockImplementationOnce, to simulate a concurrent writer winning the exclusive create -- vi.spyOn cannot target an ESM named export directly ("Module namespace is not configurable"), so the wrap has to happen at vi.mock time instead.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});

function tempDir(): string {
  return fs.mkdtempSync(path.join(tmpdir(), "agent-comms-user-identity-test-"));
}

function identityFile(dir: string): string {
  return path.join(dir, "user-identity.json");
}

afterEach(() => {
  vi.restoreAllMocks();
});

test("loadOrCreateUserIdentity persists and reloads the same key material", () => {
  const dir = tempDir();
  const first = loadOrCreateUserIdentity({ dir });

  const reloaded = loadOrCreateUserIdentity({ dir });
  expect(reloaded.fingerprint).toBe(first.fingerprint);
  expect(reloaded.privateKey).toBe(first.privateKey);
  expect(reloaded.certificate).toBe(first.certificate);
  expect(reloaded.deviceId).toEqual(first.deviceId);
});

// Mask isolating the permission bits from a stat mode's file-type bits.
const PERMISSION_BITS_MASK = 0o777;
// Expected owner-only read/write permission bits for a persisted identity file.
const OWNER_ONLY_RW_PERMISSIONS = 0o600;

test("the identity file is created with owner-only permissions", () => {
  const dir = tempDir();
  loadOrCreateUserIdentity({ dir });

  const mode = fs.statSync(identityFile(dir)).mode & PERMISSION_BITS_MASK;
  expect(mode).toBe(OWNER_ONLY_RW_PERMISSIONS);
});

test("two different directories never share an identity", () => {
  const a = loadOrCreateUserIdentity({ dir: tempDir() });
  const b = loadOrCreateUserIdentity({ dir: tempDir() });

  expect(a.fingerprint).not.toBe(b.fingerprint);
  expect(a.deviceId).not.toEqual(b.deviceId);
});

// Offset (in milliseconds) from now used to write a stored identity's expiresAt just inside the renewal window, without it having already expired outright.
const NEAR_EXPIRY_OFFSET_MS = 1000;

test("a near-expiry identity is renewed without rotating the device-id", () => {
  const dir = tempDir();
  const original = loadOrCreateUserIdentity({ dir });

  const file = identityFile(dir);
  const stored = JSON.parse(fs.readFileSync(file, "utf-8")) as {
    expiresAt: string;
  };
  stored.expiresAt = new Date(Date.now() + NEAR_EXPIRY_OFFSET_MS).toISOString();
  fs.writeFileSync(file, JSON.stringify(stored));

  const renewed = loadOrCreateUserIdentity({ dir });
  expect(renewed.deviceId).toEqual(original.deviceId);
  expect(renewed.privateKey).toBe(original.privateKey);
  expect(renewed.fingerprint).not.toBe(original.fingerprint);
});

test("a corrupt identity file is regenerated", () => {
  const dir = tempDir();
  loadOrCreateUserIdentity({ dir });
  fs.writeFileSync(identityFile(dir), "{not json");

  const regenerated = loadOrCreateUserIdentity({ dir });
  expect(regenerated.fingerprint).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2})+$/);
});

test("losing the creation race re-reads the winner's identity instead of overwriting it", () => {
  const dir = tempDir();
  const file = identityFile(dir);
  const winner = loadOrCreateUserIdentity({ dir: tempDir() });
  const realWriteFileSync = fs.writeFileSync;

  // Simulate a second process winning the exclusive ("wx") create right before this process's own write lands: when this process attempts its create, first write the "winner's" identity for real (as the concurrent process would have -- the recursive call below falls through to the real writeFileSync once this queued override is consumed), then fail this call with EEXIST, exactly as Node's own "wx" flag would for a file that now exists. expiresAt is set a full validity period out, matching persistedRecord's own real behaviour, so this test exercises only the race-handling branch, not renewal too.
  const writeSpy = vi.mocked(fs.writeFileSync).mockImplementationOnce(() => {
    realWriteFileSync(
      file,
      `${JSON.stringify(
        {
          privateKey: winner.privateKey,
          certificate: winner.certificate,
          expiresAt: new Date(
            Date.now() + CERTIFICATE_VALIDITY_MS,
          ).toISOString(),
        },
        null,
        2,
      )}\n`,
      { encoding: "utf-8", mode: 0o600 },
    );
    const err = new Error(
      "EEXIST: file already exists",
    ) as NodeJS.ErrnoException;
    err.code = "EEXIST";
    throw err;
  });

  const loser = loadOrCreateUserIdentity({ dir });

  expect(writeSpy).toHaveBeenCalled();
  expect(loser.fingerprint).toBe(winner.fingerprint);
  expect(loser.deviceId).toEqual(winner.deviceId);
});

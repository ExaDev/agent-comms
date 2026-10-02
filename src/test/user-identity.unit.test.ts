/**
 * Unit tests for the persistent user-principal identity (core/user-identity).
 */

import * as fs from "node:fs";
import type * as FsModule from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, vi, afterEach } from "vitest";
import {
  clearLegacyIssuedGrants,
  loadOrCreateLedgerWriterNonce,
  loadOrCreateUserIdentity,
  loadUserDisplayName,
  saveUserDisplayName,
  readLegacyIssuedGrants,
} from "../core/user-identity.js";
import { CERTIFICATE_VALIDITY_MS } from "../core/identity.js";
import { generateWriterNonce } from "../core/account-ledger-crypto.js";
import { randomId } from "../core/random-id.js";

// node:fs's linkSync is wrapped (not replaced) so every test gets the real filesystem by default; only the one race test below overrides it, via mockImplementationOnce, to simulate a concurrent writer winning the exclusive create. vi.spyOn cannot target an ESM named export directly ("Module namespace is not configurable"), so the wrap has to happen at vi.mock time instead.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return { ...actual, linkSync: vi.fn(actual.linkSync) };
});

/** The error link() raises for a name that already exists, carrying the errno code the create checks for. */
class ExistsError extends Error {
  readonly code = "EEXIST";

  constructor() {
    super("EEXIST: file already exists");
  }
}

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

test("a corrupt identity file is refused and left as it is, never replaced with a fresh key", () => {
  const dir = tempDir();
  loadOrCreateUserIdentity({ dir });
  fs.writeFileSync(identityFile(dir), "{not json");

  expect(() => loadOrCreateUserIdentity({ dir })).toThrow(
    /does not hold a usable identity record/,
  );
  expect(fs.readFileSync(identityFile(dir), "utf-8")).toBe("{not json");
});

test("valid key material beside malformed grant bookkeeping is refused at load, the same verdict the ledger writer nonce read would reach", () => {
  const dir = tempDir();
  loadOrCreateUserIdentity({ dir });
  const file = identityFile(dir);
  const stored: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
  const damaged = JSON.stringify({
    ...(typeof stored === "object" ? stored : {}),
    issuedDmGrants: { bearer: 7 },
  });
  fs.writeFileSync(file, damaged);

  expect(() => loadOrCreateUserIdentity({ dir })).toThrow(
    /does not hold a usable identity record/,
  );
  expect(() =>
    loadOrCreateLedgerWriterNonce({ dir }, () => new Uint8Array([1])),
  ).toThrow(/does not hold a usable identity record/);
  expect(fs.readFileSync(file, "utf-8")).toBe(damaged);
});

test("an empty identity file is refused rather than regenerated, since an atomic write never leaves one behind", () => {
  const dir = tempDir();
  loadOrCreateUserIdentity({ dir });
  fs.writeFileSync(identityFile(dir), "");

  expect(() => loadOrCreateUserIdentity({ dir })).toThrow(
    /does not hold a usable identity record/,
  );
});

test("losing the creation race re-reads the winner's identity instead of overwriting it", () => {
  const dir = tempDir();
  const file = identityFile(dir);
  const winner = loadOrCreateUserIdentity({ dir: tempDir() });

  // Simulate a second process winning the exclusive create right before this process links its own file into place: write the winner's identity for real, as the concurrent process would have, then fail this link with EEXIST, exactly as link() does for a name that now exists. expiresAt is a full validity period out, as a real create writes it, so this test exercises only the race-handling branch, not renewal too.
  const linkSpy = vi.mocked(fs.linkSync).mockImplementationOnce(() => {
    fs.writeFileSync(
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
    throw new ExistsError();
  });

  const loser = loadOrCreateUserIdentity({ dir });

  expect(linkSpy).toHaveBeenCalled();
  expect(loser.fingerprint).toBe(winner.fingerprint);
  expect(loser.deviceId).toEqual(winner.deviceId);
});

/** Reads user-identity.json as a plain object, the way a test inspects or edits fields a real build would have written. */
function readStoredRecord(dir: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(
    fs.readFileSync(identityFile(dir), "utf-8"),
  );
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("user-identity.json is not an object");
  }
  return { ...parsed };
}

function writeStoredRecord(dir: string, record: Record<string, unknown>): void {
  fs.writeFileSync(identityFile(dir), JSON.stringify(record));
}

/** The token-ids a pre-ledger build recorded in the fixture below: arbitrary, distinct, and only compared for identity. */
const LEGACY_TOKENS = {
  deviceA: randomId(),
  deviceB: randomId(),
  bearerA: randomId(),
};

const LEGACY_GRANTS = [
  { kind: "device", subject: "device-a", tokenId: LEGACY_TOKENS.deviceA },
  { kind: "device", subject: "device-b", tokenId: LEGACY_TOKENS.deviceB },
  { kind: "dm", subject: "bearer-a", tokenId: LEGACY_TOKENS.bearerA },
];

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** What a build before the replicated ledger left behind after admitting two devices and granting one DM. */
function writeLegacyLedger(dir: string): void {
  writeStoredRecord(dir, {
    ...readStoredRecord(dir),
    issuedDeviceGrants: {
      "device-a": base64(LEGACY_TOKENS.deviceA),
      "device-b": base64(LEGACY_TOKENS.deviceB),
    },
    issuedDmGrants: { "bearer-a": base64(LEGACY_TOKENS.bearerA) },
  });
}

test("loadOrCreateLedgerWriterNonce generates a nonce once and returns the same one after that", () => {
  const dir = tempDir();
  loadOrCreateUserIdentity({ dir });
  const generated = generateWriterNonce();
  const generate = vi.fn(() => generated);

  const first = loadOrCreateLedgerWriterNonce({ dir }, generate);
  const second = loadOrCreateLedgerWriterNonce({ dir }, generate);

  expect(first).toEqual(generated);
  expect(second).toEqual(first);
  expect(generate).toHaveBeenCalledTimes(1);
});

test("readLegacyIssuedGrants returns every grant a pre-ledger build recorded", () => {
  const dir = tempDir();
  loadOrCreateUserIdentity({ dir });
  writeLegacyLedger(dir);

  expect(readLegacyIssuedGrants({ dir })).toEqual(LEGACY_GRANTS);
});

test("readLegacyIssuedGrants is empty for an identity this build created", () => {
  const dir = tempDir();
  loadOrCreateUserIdentity({ dir });

  expect(readLegacyIssuedGrants({ dir })).toEqual([]);
});

test("clearLegacyIssuedGrants removes exactly the migrated grants and keeps the key material", () => {
  const dir = tempDir();
  const identity = loadOrCreateUserIdentity({ dir });
  writeLegacyLedger(dir);
  const migrated = readLegacyIssuedGrants({ dir }).filter(
    (grant) => grant.subject !== "device-b",
  );

  clearLegacyIssuedGrants({ dir }, migrated);

  expect(readLegacyIssuedGrants({ dir })).toEqual([
    { kind: "device", subject: "device-b", tokenId: LEGACY_TOKENS.deviceB },
  ]);
  expect(readStoredRecord(dir)).not.toHaveProperty("issuedDmGrants");
  expect(loadOrCreateUserIdentity({ dir }).privateKey).toBe(
    identity.privateKey,
  );
});

test("a renewed identity keeps its ledger writer nonce and any unmigrated grants", () => {
  const dir = tempDir();
  loadOrCreateUserIdentity({ dir });
  const nonce = loadOrCreateLedgerWriterNonce({ dir }, generateWriterNonce);
  writeLegacyLedger(dir);
  writeStoredRecord(dir, {
    ...readStoredRecord(dir),
    expiresAt: new Date(Date.now() + NEAR_EXPIRY_OFFSET_MS).toISOString(),
  });

  loadOrCreateUserIdentity({ dir });

  expect(loadOrCreateLedgerWriterNonce({ dir }, generateWriterNonce)).toEqual(
    nonce,
  );
  expect(readLegacyIssuedGrants({ dir })).toEqual(LEGACY_GRANTS);
});

test("a user display name is stored beside the key, replaced, cleared, and survives the key being reloaded", () => {
  const dir = tempDir();
  const identity = loadOrCreateUserIdentity({ dir });
  expect(loadUserDisplayName({ dir })).toBeUndefined();

  saveUserDisplayName({ dir }, "work account");
  expect(loadUserDisplayName({ dir })).toBe("work account");
  expect(loadOrCreateUserIdentity({ dir }).privateKey).toBe(
    identity.privateKey,
  );

  saveUserDisplayName({ dir }, "home account");
  expect(loadUserDisplayName({ dir })).toBe("home account");

  saveUserDisplayName({ dir }, undefined);
  expect(loadUserDisplayName({ dir })).toBeUndefined();
});

test("saving a user display name keeps the ledger writer nonce", () => {
  const dir = tempDir();
  loadOrCreateUserIdentity({ dir });
  const nonce = loadOrCreateLedgerWriterNonce({ dir }, generateWriterNonce);

  saveUserDisplayName({ dir }, "work account");

  expect(loadOrCreateLedgerWriterNonce({ dir }, generateWriterNonce)).toEqual(
    nonce,
  );
});

test("a user display name cannot be saved before the account exists", () => {
  expect(() => {
    saveUserDisplayName({ dir: tempDir() }, "too early");
  }).toThrow(/no user identity persisted yet/);
});

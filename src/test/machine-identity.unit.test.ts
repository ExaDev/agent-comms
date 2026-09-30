/**
 * Unit tests for the per-host machine identity (core/machine-identity, agent-comms#343): one locally generated keypair per identity directory, persisted beside the user principal but never the same key.
 */

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import {
  loadOrCreateMachineIdentity,
  machineIdentityFile,
} from "../core/machine-identity.js";
import { loadOrCreateUserIdentity } from "../core/user-identity.js";

/** Mask isolating the permission bits from a stat mode's file-type bits. */
const PERMISSION_BITS_MASK = 0o777;
/** Owner-only read and write, the mode every identity file is written with. */
const OWNER_ONLY_RW_PERMISSIONS = 0o600;

function tempDir(): string {
  return fs.mkdtempSync(path.join(tmpdir(), "agent-comms-machine-identity-"));
}

test("the machine identity is created once and reloaded unchanged from machine-identity.json", () => {
  const dir = tempDir();
  const first = loadOrCreateMachineIdentity({ dir });

  const reloaded = loadOrCreateMachineIdentity({ dir });

  expect(machineIdentityFile({ dir })).toBe(
    path.join(dir, "machine-identity.json"),
  );
  expect(fs.existsSync(path.join(dir, "machine-identity.json"))).toBe(true);
  expect(reloaded.privateKey).toBe(first.privateKey);
  expect(reloaded.deviceId).toEqual(first.deviceId);
});

test("the machine identity file is owner-only", () => {
  const dir = tempDir();
  loadOrCreateMachineIdentity({ dir });

  const mode =
    fs.statSync(machineIdentityFile({ dir })).mode & PERMISSION_BITS_MASK;
  expect(mode).toBe(OWNER_ONLY_RW_PERMISSIONS);
});

test("the machine and the user principal sharing a directory are different keys", () => {
  const dir = tempDir();

  const machine = loadOrCreateMachineIdentity({ dir });
  const user = loadOrCreateUserIdentity({ dir });

  expect(machine.deviceId).not.toEqual(user.deviceId);
  expect(loadOrCreateMachineIdentity({ dir }).deviceId).toEqual(
    machine.deviceId,
  );
});

test("two hosts, two directories, never share a machine identity", () => {
  const a = loadOrCreateMachineIdentity({ dir: tempDir() });
  const b = loadOrCreateMachineIdentity({ dir: tempDir() });

  expect(a.deviceId).not.toEqual(b.deviceId);
});

test("a corrupt machine identity file is refused rather than replaced, so the machine id never changes silently", () => {
  const dir = tempDir();
  loadOrCreateMachineIdentity({ dir });
  fs.writeFileSync(machineIdentityFile({ dir }), "not json{{");

  expect(() => loadOrCreateMachineIdentity({ dir })).toThrow(
    /does not hold a usable identity record/,
  );
  expect(fs.readFileSync(machineIdentityFile({ dir }), "utf-8")).toBe(
    "not json{{",
  );
});

test("renewing a machine identity replaces the file atomically, so a reader never sees it partly written", () => {
  const dir = tempDir();
  const file = machineIdentityFile({ dir });
  const original = loadOrCreateMachineIdentity({ dir });
  const inodeBefore = fs.statSync(file).ino;
  const stored: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
  if (typeof stored !== "object" || stored === null) {
    throw new Error("expected a stored record");
  }
  fs.writeFileSync(
    file,
    JSON.stringify({ ...stored, expiresAt: new Date(0).toISOString() }),
  );

  const renewed = loadOrCreateMachineIdentity({ dir });

  expect(renewed.deviceId).toEqual(original.deviceId);
  expect(fs.statSync(file).ino).not.toBe(inodeBefore);
});

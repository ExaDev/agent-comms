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

test("a corrupt machine identity file is replaced with a fresh key", () => {
  const dir = tempDir();
  const original = loadOrCreateMachineIdentity({ dir });
  fs.writeFileSync(machineIdentityFile({ dir }), "not json{{");

  const replaced = loadOrCreateMachineIdentity({ dir });

  expect(replaced.deviceId).not.toEqual(original.deviceId);
  expect(loadOrCreateMachineIdentity({ dir }).deviceId).toEqual(
    replaced.deviceId,
  );
});

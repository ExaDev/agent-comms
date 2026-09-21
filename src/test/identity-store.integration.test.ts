/**
 * Unit tests for persistent bridge identity (core/identity-store).
 */

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { test, expect } from "vitest";
import { mintCapabilityToken } from "wire-mesh-core/domain/tokens";
import { createSystemClock } from "wire-mesh-core/adapters/system-clock";
import type { CapabilityToken } from "wire-mesh-core/generated/protocol";
import { generateIdentity } from "../core/identity.js";
import { toIdentityPort } from "../core/wire-mesh-identity.js";
import {
  deleteGroupToken,
  gatewayTrustStamp,
  loadGatewayTrust,
  loadGroupTokens,
  loadOrCreateIdentity,
  loadIdentityForFront,
  probeSlotOwner,
  oplogDirFor,
  releaseIdentityLock,
  saveGatewayTrust,
  saveGroupToken,
  type IdentitySlot,
} from "../core/identity-store.js";

const TOKEN_TTL_MS = 60_000;

/** A real, minted group:member token -- not an opaque placeholder -- so these tests exercise the actual (de)serialization round trip a real CapabilityToken tuple needs. groupPath is purely a storage key from this test's own point of view, distinct from the bearer device the fixture token happens to name. */
async function mintGroupToken(groupPath: string): Promise<CapabilityToken> {
  const issuer = await toIdentityPort(generateIdentity());
  const bearer = await toIdentityPort(generateIdentity());
  const clock = createSystemClock();
  const verdict = await mintCapabilityToken({
    identity: issuer,
    clock,
    tokenId: Uint8Array.from([1]),
    bearer: bearer.deviceId,
    capability: "group:member",
    scope: { kind: "group", path: groupPath },
    expires: clock.now() + TOKEN_TTL_MS,
    delegationsRemaining: 0,
  });
  if (!verdict.ok)
    throw new Error("expected the fixture token to mint successfully");
  return verdict.token;
}

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

/** The one file every slot in an identity directory shares its gateway trust through. */
const GATEWAY_TRUST_FILE = "gateway-trust.json";

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

test("probeSlotOwner reports undefined for a never-touched slot", () => {
  const { slot } = tempSlot("claude-code");
  expect(probeSlotOwner(slot)).toBeUndefined();
});

test("probeSlotOwner reports the live PID holding a slot's lock", () => {
  const { slot } = tempSlot("claude-code");
  loadOrCreateIdentity(slot);
  expect(probeSlotOwner(slot)).toBe(process.pid);
  releaseIdentityLock(slot);
});

test("probeSlotOwner reports undefined once the lock is released", () => {
  const { slot } = tempSlot("claude-code");
  loadOrCreateIdentity(slot);
  releaseIdentityLock(slot);
  expect(probeSlotOwner(slot)).toBeUndefined();
});

test("probeSlotOwner reports undefined for a lock left by a dead process", () => {
  const { slot, dir } = tempSlot("claude-code");
  loadOrCreateIdentity(slot);
  const lockFile = slotFile(dir, ".lock");
  releaseIdentityLock(slot);
  // A pid that is exceedingly unlikely to be alive on any real machine, standing in for a crashed process's stale lock file (matching the "a stale lock from a dead process" test above, which relies on the same never-recycled-in-practice assumption).
  const deadPid = 999_999;
  fs.writeFileSync(lockFile, `${String(deadPid)}\n`);
  expect(probeSlotOwner(slot)).toBeUndefined();
});

test("loadIdentityForFront creates and persists an identity without taking the slot's lock", () => {
  const { slot, dir } = tempSlot("claude-code");
  const identity = loadIdentityForFront(slot);
  expect(fs.existsSync(slotFile(dir, ".json"))).toBe(true);
  expect(
    fs.existsSync(path.join(dir, "identity-claude-code--_tmp_project.lock")),
  ).toBe(false);
  expect(probeSlotOwner(slot)).toBeUndefined();

  const reloaded = loadIdentityForFront(slot);
  expect(reloaded.fingerprint).toBe(identity.fingerprint);
  expect(reloaded.deviceId).toEqual(identity.deviceId);
});

test("loadIdentityForFront's identity matches what loadOrCreateIdentity would later assume for the same slot", () => {
  const { slot } = tempSlot("claude-code");
  const front = loadIdentityForFront(slot);

  const owned = loadOrCreateIdentity(slot);
  expect(owned.fingerprint).toBe(front.fingerprint);
  expect(owned.deviceId).toEqual(front.deviceId);
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

test("loadGroupTokens is empty for a slot that has never saved one", () => {
  const { slot } = tempSlot("pi");
  loadOrCreateIdentity(slot);
  expect(loadGroupTokens(slot)).toEqual({});
  releaseIdentityLock(slot);
});

test("saveGroupToken persists a token, loadGroupTokens reloads it keyed by group path", async () => {
  const { slot } = tempSlot("pi");
  loadOrCreateIdentity(slot);
  const token = await mintGroupToken("group-path-1");

  saveGroupToken(slot, "group-path-1", token);

  expect(loadGroupTokens(slot)).toEqual({ "group-path-1": token });
  releaseIdentityLock(slot);
});

test("saveGroupToken overwrites only the given group path, leaving others and the identity's own key material untouched", async () => {
  const { slot } = tempSlot("pi");
  const identity = loadOrCreateIdentity(slot);
  const tokenA = await mintGroupToken("group-a");
  const tokenB = await mintGroupToken("group-b");
  saveGroupToken(slot, "group-a", tokenA);
  saveGroupToken(slot, "group-b", tokenB);

  const tokenAReplacement = await mintGroupToken("group-a");
  saveGroupToken(slot, "group-a", tokenAReplacement);

  expect(loadGroupTokens(slot)).toEqual({
    "group-a": tokenAReplacement,
    "group-b": tokenB,
  });
  const reloaded = loadOrCreateIdentity(slot);
  expect(reloaded.privateKey).toBe(identity.privateKey);
  releaseIdentityLock(slot);
});

test("deleteGroupToken removes one group path's token, leaving others in place", async () => {
  const { slot } = tempSlot("pi");
  loadOrCreateIdentity(slot);
  const tokenA = await mintGroupToken("group-a");
  const tokenB = await mintGroupToken("group-b");
  saveGroupToken(slot, "group-a", tokenA);
  saveGroupToken(slot, "group-b", tokenB);

  deleteGroupToken(slot, "group-a");

  expect(loadGroupTokens(slot)).toEqual({ "group-b": tokenB });
  releaseIdentityLock(slot);
});

test("deleteGroupToken is a no-op when nothing was saved for that group path", () => {
  const { slot } = tempSlot("pi");
  loadOrCreateIdentity(slot);
  expect(() => {
    deleteGroupToken(slot, "never-saved");
  }).not.toThrow();
  expect(loadGroupTokens(slot)).toEqual({});
  releaseIdentityLock(slot);
});

test("loadGatewayTrust is empty for a slot that has never saved a trusted set", () => {
  const { slot } = tempSlot("pi");
  expect(loadGatewayTrust(slot)).toEqual({ devices: [], principals: [] });
});

test("loadGatewayTrust does not require an identity to have been created first, unlike loadRoomTokens/loadGroupTokens", () => {
  const { slot } = tempSlot("pi");
  expect(() => {
    saveGatewayTrust(slot, ["aabbcc"], []);
  }).not.toThrow();
  expect(loadGatewayTrust(slot)).toEqual({
    devices: ["aabbcc"],
    principals: [],
  });
});

test("saveGatewayTrust persists the trusted device and principal sets, loadGatewayTrust reloads the same lists", () => {
  const { slot } = tempSlot("pi");
  saveGatewayTrust(slot, ["aabbcc", "ddeeff"], ["112233"]);
  expect(loadGatewayTrust(slot)).toEqual({
    devices: ["aabbcc", "ddeeff"],
    principals: ["112233"],
  });
});

test("saveGatewayTrust overwrites the previously saved sets rather than merging with them", () => {
  const { slot } = tempSlot("pi");
  saveGatewayTrust(slot, ["aabbcc", "ddeeff"], ["112233"]);
  saveGatewayTrust(slot, ["112233"], ["445566"]);
  expect(loadGatewayTrust(slot)).toEqual({
    devices: ["112233"],
    principals: ["445566"],
  });
});

test("saveGatewayTrust persists empty sets, clearing whatever was saved before", () => {
  const { slot } = tempSlot("pi");
  saveGatewayTrust(slot, ["aabbcc"], ["112233"]);
  saveGatewayTrust(slot, [], []);
  expect(loadGatewayTrust(slot)).toEqual({ devices: [], principals: [] });
});

test("the gateway trust file is written with owner-only permissions", () => {
  const { slot, dir } = tempSlot("pi");
  saveGatewayTrust(slot, ["aabbcc"], []);
  const file = fs.readdirSync(dir).find((f) => f === GATEWAY_TRUST_FILE);
  expect(file, `expected ${GATEWAY_TRUST_FILE} in ${dir}`).toBeDefined();
  if (file === undefined) throw new Error("expected a gateway-trust file");
  const mode = fs.statSync(path.join(dir, file)).mode & PERMISSION_BITS_MASK;
  expect(mode).toBe(OWNER_ONLY_RW_PERMISSIONS);
});

test("the gateway trust file is shared by every slot in an identity directory", () => {
  const { slot, dir } = tempSlot("pi");
  saveGatewayTrust(slot, ["aabbcc"], []);
  const otherHarness: IdentitySlot = { ...slot, harness: "claude-code" };
  const otherCwd: IdentitySlot = { ...slot, cwd: "/somewhere/else" };
  expect(loadGatewayTrust(otherHarness).devices).toEqual(["aabbcc"]);
  expect(loadGatewayTrust(otherCwd).devices).toEqual(["aabbcc"]);
  expect(
    fs.readdirSync(dir).filter((f) => f.startsWith("gateway-trust")),
  ).toEqual([GATEWAY_TRUST_FILE]);
});

test("gatewayTrustStamp changes when the trust file is created, rewritten, or removed", () => {
  const { slot, dir } = tempSlot("pi");
  const absent = gatewayTrustStamp(slot);
  saveGatewayTrust(slot, ["aabbcc"], []);
  const created = gatewayTrustStamp(slot);
  saveGatewayTrust(slot, ["aabbcc"], []);
  const rewritten = gatewayTrustStamp(slot);
  fs.rmSync(path.join(dir, GATEWAY_TRUST_FILE));
  const stamps = [absent, created, rewritten];
  expect(new Set(stamps).size).toBe(stamps.length);
  expect(gatewayTrustStamp(slot)).toBe(absent);
});

test("loadGatewayTrust returns empty for a slot whose gateway trust file is corrupt", () => {
  const { slot, dir } = tempSlot("pi");
  saveGatewayTrust(slot, ["aabbcc"], []);
  const file = fs.readdirSync(dir).find((f) => f === GATEWAY_TRUST_FILE);
  if (file === undefined) throw new Error("expected a gateway-trust file");
  fs.writeFileSync(path.join(dir, file), "not valid json{{{");
  expect(loadGatewayTrust(slot)).toEqual({ devices: [], principals: [] });
});

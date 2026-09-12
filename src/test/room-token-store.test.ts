/**
 * Unit tests for per-room capability token persistence (core/identity-store).
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { CapabilityToken } from "wire-mesh-core/generated/protocol";
import {
  loadOrCreateIdentity,
  loadRoomTokens,
  saveRoomToken,
  deleteRoomToken,
  releaseIdentityLock,
  type IdentitySlot,
} from "../core/identity-store.js";

function tempSlot(harness: string): { slot: IdentitySlot; dir: string } {
  const dir = fs.mkdtempSync(
    path.join(tmpdir(), "agent-comms-room-token-test-"),
  );
  return { slot: { harness, cwd: "/tmp/project", dir }, dir };
}

function buf(bytes: number[]): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(bytes);
}

const TOKEN_A: CapabilityToken = [
  buf([1, 2, 3]),
  {},
  buf([4, 5, 6]),
  buf([7, 8, 9]),
];
const TOKEN_B: CapabilityToken = [
  buf([10, 11]),
  { 1: -7 },
  null,
  buf([12, 13, 14]),
];
const ROOM_A = "aa".repeat(32) + "/general";
const ROOM_B = "bb".repeat(32) + "/other-room";

void test("loadRoomTokens returns an empty map before anything is saved", () => {
  const { slot } = tempSlot("pi");
  loadOrCreateIdentity(slot);
  assert.deepEqual(loadRoomTokens(slot), {});
  releaseIdentityLock(slot);
});

void test("saveRoomToken persists a token retrievable by loadRoomTokens", () => {
  const { slot } = tempSlot("claude-code");
  loadOrCreateIdentity(slot);
  saveRoomToken(slot, ROOM_A, TOKEN_A);

  const tokens = loadRoomTokens(slot);
  assert.deepEqual(tokens[ROOM_A], TOKEN_A);
  releaseIdentityLock(slot);
});

void test("saveRoomToken round-trips a token whose payload is null", () => {
  const { slot } = tempSlot("codex");
  loadOrCreateIdentity(slot);
  saveRoomToken(slot, ROOM_B, TOKEN_B);

  const tokens = loadRoomTokens(slot);
  assert.deepEqual(tokens[ROOM_B], TOKEN_B);
  releaseIdentityLock(slot);
});

void test("saveRoomToken for a second room does not disturb the first", () => {
  const { slot } = tempSlot("mcp");
  loadOrCreateIdentity(slot);
  saveRoomToken(slot, ROOM_A, TOKEN_A);
  saveRoomToken(slot, ROOM_B, TOKEN_B);

  const tokens = loadRoomTokens(slot);
  assert.deepEqual(tokens[ROOM_A], TOKEN_A);
  assert.deepEqual(tokens[ROOM_B], TOKEN_B);
  releaseIdentityLock(slot);
});

void test("saveRoomToken overwrites an existing token for the same room", () => {
  const { slot } = tempSlot("opencode");
  loadOrCreateIdentity(slot);
  saveRoomToken(slot, ROOM_A, TOKEN_A);
  saveRoomToken(slot, ROOM_A, TOKEN_B);

  const tokens = loadRoomTokens(slot);
  assert.deepEqual(tokens[ROOM_A], TOKEN_B);
  assert.equal(Object.keys(tokens).length, 1);
  releaseIdentityLock(slot);
});

void test("deleteRoomToken removes only the named room's token", () => {
  const { slot } = tempSlot("user");
  loadOrCreateIdentity(slot);
  saveRoomToken(slot, ROOM_A, TOKEN_A);
  saveRoomToken(slot, ROOM_B, TOKEN_B);

  deleteRoomToken(slot, ROOM_A);

  const tokens = loadRoomTokens(slot);
  assert.equal(ROOM_A in tokens, false);
  assert.deepEqual(tokens[ROOM_B], TOKEN_B);
  releaseIdentityLock(slot);
});

void test("room tokens survive reloading the identity file across a fresh load", () => {
  const { slot } = tempSlot("pi");
  loadOrCreateIdentity(slot);
  saveRoomToken(slot, ROOM_A, TOKEN_A);
  releaseIdentityLock(slot);

  // A fresh process re-loading the same slot.
  loadOrCreateIdentity(slot);
  const tokens = loadRoomTokens(slot);
  assert.deepEqual(tokens[ROOM_A], TOKEN_A);
  releaseIdentityLock(slot);
});

void test("saving a room token does not disturb the persisted key material", () => {
  const { slot } = tempSlot("claude-code");
  const identity = loadOrCreateIdentity(slot);
  saveRoomToken(slot, ROOM_A, TOKEN_A);

  const reloaded = loadOrCreateIdentity(slot);
  assert.equal(reloaded.privateKey, identity.privateKey);
  assert.equal(reloaded.certificate, identity.certificate);
  releaseIdentityLock(slot);
});

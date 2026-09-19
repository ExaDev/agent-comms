/**
 * Unit tests for per-room capability token persistence (core/identity-store).
 */

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect } from "vitest";
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

function buf(bytes: readonly number[]): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(bytes);
}

// Arbitrary distinct byte values distinguishing each COSE_Sign1 segment across TOKEN_A/TOKEN_B in round-trip assertions -- the values themselves carry no meaning beyond being distinguishable.
const TOKEN_A_PROTECTED_HEADER_BYTE_3 = 3;
const TOKEN_A_PAYLOAD_BYTE_1 = 4;
const TOKEN_A_PAYLOAD_BYTE_2 = 5;
const TOKEN_A_PAYLOAD_BYTE_3 = 6;
const TOKEN_A_SIGNATURE_BYTE_1 = 7;
const TOKEN_A_SIGNATURE_BYTE_2 = 8;
const TOKEN_A_SIGNATURE_BYTE_3 = 9;
const TOKEN_B_PROTECTED_HEADER_BYTE_1 = 10;
const TOKEN_B_PROTECTED_HEADER_BYTE_2 = 11;
const TOKEN_B_SIGNATURE_BYTE_1 = 12;
const TOKEN_B_SIGNATURE_BYTE_2 = 13;
const TOKEN_B_SIGNATURE_BYTE_3 = 14;

const TOKEN_A: CapabilityToken = [
  buf([1, 2, TOKEN_A_PROTECTED_HEADER_BYTE_3]),
  {},
  buf([TOKEN_A_PAYLOAD_BYTE_1, TOKEN_A_PAYLOAD_BYTE_2, TOKEN_A_PAYLOAD_BYTE_3]),
  buf([
    TOKEN_A_SIGNATURE_BYTE_1,
    TOKEN_A_SIGNATURE_BYTE_2,
    TOKEN_A_SIGNATURE_BYTE_3,
  ]),
];
const TOKEN_B: CapabilityToken = [
  buf([TOKEN_B_PROTECTED_HEADER_BYTE_1, TOKEN_B_PROTECTED_HEADER_BYTE_2]),
  { 1: -7 },
  null,
  buf([
    TOKEN_B_SIGNATURE_BYTE_1,
    TOKEN_B_SIGNATURE_BYTE_2,
    TOKEN_B_SIGNATURE_BYTE_3,
  ]),
];

// Length of each synthetic room-ID's hex-device-id prefix, matching the real 32-byte device-id's hex encoding.
const ROOM_ID_HEX_PAIR_COUNT = 32;
const ROOM_A = "aa".repeat(ROOM_ID_HEX_PAIR_COUNT) + "/general";
const ROOM_B = "bb".repeat(ROOM_ID_HEX_PAIR_COUNT) + "/other-room";

test("loadRoomTokens returns an empty map before anything is saved", () => {
  const { slot } = tempSlot("pi");
  loadOrCreateIdentity(slot);
  expect(loadRoomTokens(slot)).toEqual({});
  releaseIdentityLock(slot);
});

test("saveRoomToken persists a token retrievable by loadRoomTokens", () => {
  const { slot } = tempSlot("claude-code");
  loadOrCreateIdentity(slot);
  saveRoomToken(slot, ROOM_A, TOKEN_A);

  const tokens = loadRoomTokens(slot);
  expect(tokens[ROOM_A]).toEqual(TOKEN_A);
  releaseIdentityLock(slot);
});

test("saveRoomToken round-trips a token whose payload is null", () => {
  const { slot } = tempSlot("codex");
  loadOrCreateIdentity(slot);
  saveRoomToken(slot, ROOM_B, TOKEN_B);

  const tokens = loadRoomTokens(slot);
  expect(tokens[ROOM_B]).toEqual(TOKEN_B);
  releaseIdentityLock(slot);
});

test("saveRoomToken for a second room does not disturb the first", () => {
  const { slot } = tempSlot("mcp");
  loadOrCreateIdentity(slot);
  saveRoomToken(slot, ROOM_A, TOKEN_A);
  saveRoomToken(slot, ROOM_B, TOKEN_B);

  const tokens = loadRoomTokens(slot);
  expect(tokens[ROOM_A]).toEqual(TOKEN_A);
  expect(tokens[ROOM_B]).toEqual(TOKEN_B);
  releaseIdentityLock(slot);
});

test("saveRoomToken overwrites an existing token for the same room", () => {
  const { slot } = tempSlot("opencode");
  loadOrCreateIdentity(slot);
  saveRoomToken(slot, ROOM_A, TOKEN_A);
  saveRoomToken(slot, ROOM_A, TOKEN_B);

  const tokens = loadRoomTokens(slot);
  expect(tokens[ROOM_A]).toEqual(TOKEN_B);
  expect(Object.keys(tokens).length).toBe(1);
  releaseIdentityLock(slot);
});

test("deleteRoomToken removes only the named room's token", () => {
  const { slot } = tempSlot("user");
  loadOrCreateIdentity(slot);
  saveRoomToken(slot, ROOM_A, TOKEN_A);
  saveRoomToken(slot, ROOM_B, TOKEN_B);

  deleteRoomToken(slot, ROOM_A);

  const tokens = loadRoomTokens(slot);
  expect(ROOM_A in tokens).toBe(false);
  expect(tokens[ROOM_B]).toEqual(TOKEN_B);
  releaseIdentityLock(slot);
});

test("room tokens survive reloading the identity file across a fresh load", () => {
  const { slot } = tempSlot("pi");
  loadOrCreateIdentity(slot);
  saveRoomToken(slot, ROOM_A, TOKEN_A);
  releaseIdentityLock(slot);

  // A fresh process re-loading the same slot.
  loadOrCreateIdentity(slot);
  const tokens = loadRoomTokens(slot);
  expect(tokens[ROOM_A]).toEqual(TOKEN_A);
  releaseIdentityLock(slot);
});

test("saving a room token does not disturb the persisted key material", () => {
  const { slot } = tempSlot("claude-code");
  const identity = loadOrCreateIdentity(slot);
  saveRoomToken(slot, ROOM_A, TOKEN_A);

  const reloaded = loadOrCreateIdentity(slot);
  expect(reloaded.privateKey).toBe(identity.privateKey);
  expect(reloaded.certificate).toBe(identity.certificate);
  releaseIdentityLock(slot);
});

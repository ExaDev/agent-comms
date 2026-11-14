/**
 * Fixture process for identity-token-writes.integration.test.ts: loads the slot's identity without taking its lock (as the cc-peer front does) and saves its own room tokens into the slot file, each one a separate read-modify-write. Starts at an absolute deadline given by the parent so every sibling writes at the same time.
 *
 * Usage: tsx identity-token-race-worker.ts <dir> <workerIndex> <tokenCount> <startAtEpochMs>
 */

import {
  loadIdentityForFront,
  saveRoomToken,
  type IdentitySlot,
} from "../core/identity-store.js";
import type { CapabilityToken } from "wire-mesh-core/generated/protocol";

const [, , dir, indexRaw, countRaw, startAtRaw] = process.argv;
if (
  dir === undefined ||
  indexRaw === undefined ||
  countRaw === undefined ||
  startAtRaw === undefined
) {
  console.error(
    "usage: identity-token-race-worker.ts <dir> <workerIndex> <tokenCount> <startAtEpochMs>",
  );
  process.exit(1);
}

const startAt = Number.parseInt(startAtRaw, 10);
while (Date.now() < startAt) {
  // Busy-wait for the shared start deadline: a timer's own scheduling jitter is the imprecision this barrier removes.
}

const slot: IdentitySlot = { harness: "token-race", cwd: "/tmp/race", dir };
// Structurally valid stand-in: saveRoomToken only serialises the byte-string fields.
const token: CapabilityToken = [
  Uint8Array.from([1]),
  {},
  null,
  Uint8Array.from([2]),
];

try {
  loadIdentityForFront(slot);
  const count = Number.parseInt(countRaw, 10);
  for (let i = 0; i < count; i++) {
    saveRoomToken(slot, `room-${indexRaw}-${String(i)}`, token);
  }
  process.exit(0);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

/**
 * Fixture process for identity-store-race.test.ts -- spawned as a real, separate Node process (not an in-process call) because the race under test is between the filesystem operations of genuinely concurrent OS processes sharing one identity slot, the same way two Playwright e2e workers (or two bridges started against the same cwd) do. Busy-waits until an absolute deadline given by its parent before calling loadOrCreateIdentity/saveRoomToken, so every sibling worker the parent spawned for the same round starts the actual race at effectively the same instant rather than whenever this process happened to finish starting up.
 *
 * Usage: tsx identity-store-race-worker.ts <dir> <harness> <startAtEpochMs>
 */

import {
  loadOrCreateIdentity,
  saveRoomToken,
  type IdentitySlot,
} from "../core/identity-store.js";
import type { CapabilityToken } from "wire-mesh-core/generated/protocol";

const [, , dir, harness, startAtRaw] = process.argv;
if (dir === undefined || harness === undefined || startAtRaw === undefined) {
  console.error(
    "usage: identity-store-race-worker.ts <dir> <harness> <startAtEpochMs>",
  );
  process.exit(1);
}

const startAt = Number.parseInt(startAtRaw, 10);
while (Date.now() < startAt) {
  // Busy-wait for the shared start deadline -- deliberately not setTimeout, whose own scheduling jitter is exactly the imprecision this barrier exists to remove.
}

const slot: IdentitySlot = { harness, cwd: "/tmp/race-project", dir };

// Not a real, cryptographically minted token -- saveRoomToken only serializes a CapabilityToken's byte-string fields, so a structurally valid stand-in exercises the identical read-modify-write path a genuine one would without needing the async minting machinery here.
const fakeToken: CapabilityToken = [
  Uint8Array.from([1]),
  {},
  null,
  Uint8Array.from([2]),
];

try {
  loadOrCreateIdentity(slot);
  saveRoomToken(slot, "race-room", fakeToken);
  process.exit(0);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

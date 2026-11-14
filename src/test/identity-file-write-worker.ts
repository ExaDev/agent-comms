/**
 * Fixture process for identity-file-writes.integration.test.ts: one kind of write to an account or machine identity file, repeated, starting at an absolute deadline given by the parent so every sibling writes at the same time.
 *
 * Usage: tsx identity-file-write-worker.ts <mode> <dir> <workerIndex> <rounds> <startAtEpochMs>
 *
 * Modes: nonce (print the ledger writer nonce this process settled on), clear (remove this worker's own legacy grants one at a time), name (save a display name per round), import (import the account already held, with a display name per round), machine-name (save the machine's display name per round), machine-renew (load the machine identity, renewing it when it is near expiry).
 */

import {
  loadOrCreateMachineIdentity,
  saveMachineDisplayName,
} from "../core/machine-identity.js";
import {
  clearLegacyIssuedGrants,
  importAccountKey,
  loadOrCreateLedgerWriterNonce,
  readAccountContents,
  readLegacyIssuedGrants,
  saveUserDisplayName,
} from "../core/user-identity.js";
import { randomBytes } from "node:crypto";

const [, , mode, dir, indexRaw, roundsRaw, startAtRaw] = process.argv;
if (
  mode === undefined ||
  dir === undefined ||
  indexRaw === undefined ||
  roundsRaw === undefined ||
  startAtRaw === undefined
) {
  console.error(
    "usage: identity-file-write-worker.ts <mode> <dir> <workerIndex> <rounds> <startAtEpochMs>",
  );
  process.exit(1);
}

const rounds = Number.parseInt(roundsRaw, 10);
const startAt = Number.parseInt(startAtRaw, 10);
const NONCE_BYTES = 16;
while (Date.now() < startAt) {
  // Busy-wait for the shared start deadline: a timer's own scheduling jitter is the imprecision this barrier removes.
}

try {
  const options = { dir };
  switch (mode) {
    case "nonce":
      console.log(
        Buffer.from(
          await loadOrCreateLedgerWriterNonce(options, () =>
            Uint8Array.from(randomBytes(NONCE_BYTES)),
          ),
        ).toString("hex"),
      );
      break;
    case "clear":
      for (const grant of readLegacyIssuedGrants(options).filter((g) =>
        g.subject.startsWith(`worker-${indexRaw}-`),
      )) {
        await clearLegacyIssuedGrants(options, [grant]);
      }
      break;
    case "name":
      for (let round = 0; round < rounds; round++) {
        await saveUserDisplayName(options, `name-${indexRaw}-${String(round)}`);
      }
      break;
    case "import": {
      const contents = readAccountContents(options);
      for (let round = 0; round < rounds; round++) {
        await importAccountKey(options, {
          ...contents,
          displayName: `import-${indexRaw}-${String(round)}`,
        });
      }
      break;
    }
    case "machine-name":
      for (let round = 0; round < rounds; round++) {
        await saveMachineDisplayName(
          options,
          `machine-${indexRaw}-${String(round)}`,
        );
      }
      break;
    case "machine-renew":
      loadOrCreateMachineIdentity(options);
      break;
    default:
      throw new Error(`unknown mode ${mode}`);
  }
  process.exit(0);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

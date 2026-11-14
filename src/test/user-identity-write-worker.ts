/**
 * Fixture process for user-identity-writes.integration.test.ts: removes its own share of the legacy issued grants from the account file, each removal a separate read-modify-write. Starts at an absolute deadline given by the parent so every sibling writes at the same time.
 *
 * Usage: tsx user-identity-write-worker.ts <dir> <workerIndex> <startAtEpochMs>
 */

import {
  clearLegacyIssuedGrants,
  readLegacyIssuedGrants,
} from "../core/user-identity.js";

const [, , dir, indexRaw, startAtRaw] = process.argv;
if (dir === undefined || indexRaw === undefined || startAtRaw === undefined) {
  console.error(
    "usage: user-identity-write-worker.ts <dir> <workerIndex> <startAtEpochMs>",
  );
  process.exit(1);
}

const startAt = Number.parseInt(startAtRaw, 10);
while (Date.now() < startAt) {
  // Busy-wait for the shared start deadline: a timer's own scheduling jitter is the imprecision this barrier removes.
}

try {
  const own = readLegacyIssuedGrants({ dir }).filter((grant) =>
    grant.subject.startsWith(`worker-${indexRaw}-`),
  );
  for (const grant of own) clearLegacyIssuedGrants({ dir }, [grant]);
  process.exit(0);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

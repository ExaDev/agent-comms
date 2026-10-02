/**
 * Fixture process for account-ledger-lock.integration.test.ts: a real, separate Node process appending to one machine's account ledger, because the lock under test serialises appends between genuinely concurrent OS processes, the way several bridges on one machine share its writer log. Busy-waits until an absolute deadline given by its parent, so every sibling worker starts appending at effectively the same instant.
 *
 * Usage: tsx account-ledger-lock-worker.ts <userIdentityDir> <subject> <appends> <startAtEpochMs>
 *
 * Records `appends` grants for `subject`, one append at a time.
 */

import { createSystemClock } from "wire-mesh-core/adapters/system-clock";
import { openAccountLedger } from "../core/account-ledger-store.js";
import { randomId } from "../core/random-id.js";
import { loadOrCreateUserIdentity } from "../core/user-identity.js";

const [, , dir, subject, appendsRaw, startAtRaw] = process.argv;
if (
  dir === undefined ||
  subject === undefined ||
  appendsRaw === undefined ||
  startAtRaw === undefined
) {
  console.error(
    "usage: account-ledger-lock-worker.ts <userIdentityDir> <subject> <appends> <startAtEpochMs>",
  );
  process.exit(1);
}

const userIdentityOptions = { dir };
const ledger = await openAccountLedger({
  userIdentityOptions,
  userIdentity: loadOrCreateUserIdentity(userIdentityOptions),
  clock: createSystemClock(),
});

const startAt = Number.parseInt(startAtRaw, 10);
while (Date.now() < startAt) {
  // Busy-wait for the shared start deadline, deliberately not setTimeout, whose scheduling jitter is the imprecision this barrier exists to remove.
}

const appends = Number.parseInt(appendsRaw, 10);
for (let i = 0; i < appends; i++) {
  await ledger.recordGrant("dm", subject, randomId());
}

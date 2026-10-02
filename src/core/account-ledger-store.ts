/**
 * Opens this machine's copy of the account's replicated grant ledger (account-ledger.ts): a filesystem store beside user-identity.json, shared by every bridge on the machine, and the one-time migration of a pre-ledger user-identity.json's own issued-grant maps into it.
 */

import * as path from "node:path";
import { createNodeFsStorage } from "wire-mesh-core/adapters/node-fs-storage";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import type { Clock } from "wire-mesh-core/ports/clock";
import { generateWriterNonce } from "./account-ledger-crypto.js";
import { AccountLedger } from "./account-ledger.js";
import type { PeerIdentity } from "./identity.js";
import { createFileLedgerLock } from "./ledger-lock.js";
import {
  clearLegacyIssuedGrants,
  loadOrCreateLedgerWriterNonce,
  readLegacyIssuedGrants,
  userIdentityDir,
  type UserIdentityOptions,
} from "./user-identity.js";

export interface OpenAccountLedgerOptions {
  /** Where user-identity.json lives; the ledger is kept beside it. */
  userIdentityOptions: Readonly<UserIdentityOptions>;
  /** The account's identity as loadOrCreateUserIdentity returned it. */
  userIdentity: Readonly<PeerIdentity>;
  clock: Clock;
}

/** The directory an account's ledger is stored in on this machine. Named by the account's device-id, so a machine that imports a different account starts that account's ledger afresh instead of mixing two accounts' logs. */
export function accountLedgerDir(
  userIdentityOptions: Readonly<UserIdentityOptions>,
  userIdentity: Readonly<PeerIdentity>,
): string {
  return path.join(
    userIdentityDir(userIdentityOptions),
    `account-ledger-${deviceIdToHex(Uint8Array.from(userIdentity.deviceId))}`,
  );
}

/**
 * Opens the account ledger for this machine and migrates any grants a pre-ledger build recorded in user-identity.json into it, so an existing user-identity.json needs no manual step: every grant it knew about stays revocable, now from any machine holding the key. The legacy maps are removed only after their grants are in the ledger, so a crash between the two re-migrates them on the next start, which is harmless because the ledger folds a grant recorded twice into one.
 */
export async function openAccountLedger(
  options: Readonly<OpenAccountLedgerOptions>,
): Promise<AccountLedger> {
  const dir = accountLedgerDir(
    options.userIdentityOptions,
    options.userIdentity,
  );
  const ledger = new AccountLedger({
    accountPrivateKey: options.userIdentity.privateKey,
    writerNonce: loadOrCreateLedgerWriterNonce(
      options.userIdentityOptions,
      generateWriterNonce,
    ),
    storage: createNodeFsStorage({ dir }),
    lock: createFileLedgerLock(`${dir}.lock`),
    clock: options.clock,
  });
  const legacy = readLegacyIssuedGrants(options.userIdentityOptions);
  if (legacy.length > 0) {
    await ledger.recordGrants(legacy);
    clearLegacyIssuedGrants(options.userIdentityOptions, legacy);
  }
  return ledger;
}

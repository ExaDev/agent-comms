/**
 * Persistent user-principal identity: a single keypair scoped to this machine account rather than any one (harness, cwd) bridge slot, the root issuer agent-comms#160 introduces, so a user principal can mint capability tokens to the devices it owns, independent of which bridge process happens to be running. See identity-store.ts for the per-slot device identity every bridge already has; this is deliberately a separate, shared identity, not a variant of it.
 *
 * Stored at ~/.agent-comms/user-identity.json (mode 0600), sibling to but distinct from any identity-<harness>--<cwd>.json slot file and to the machine identity (machine-identity.ts). Loading, creation and renewal are issuer-identity-file.ts's, shared with the machine identity; this module adds the principal's own issued-grant bookkeeping to the same record.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { certifyKeyPair } from "./identity.js";
import type { PeerIdentity } from "./identity.js";
import { CommsError } from "./store.js";
import {
  isStoredIssuerKey,
  issuerKeyRecord,
  issuerPeerIdentity,
  loadOrCreateIssuerIdentity,
  readIssuerRecord,
  writeIssuerRecord,
  type StoredIssuerKey,
} from "./issuer-identity-file.js";

export interface UserIdentityOptions {
  /** Directory override for tests; defaults to ~/.agent-comms, the same base directory identity-store.ts's own per-slot files live in. */
  dir?: string;
}

interface StoredUserIdentity extends StoredIssuerKey {
  /** This machine's writer nonce for the account's replicated grant ledger (account-ledger.ts), base64. Belongs to the machine, not the account: it is never exported with the key, since two machines appending under one nonce would share a writer log and fork it. */
  ledgerWriter?: string;
  /** The token-id (base64) of each group:member grant this principal issued, keyed by the admitted device's hex id, as builds before the replicated ledger kept them. Read only to migrate them into the ledger on first start (account-ledger-store.ts), then removed. */
  issuedDeviceGrants?: Record<string, string>;
  /** The token-id (base64) of each dm:send grant this principal issued, keyed by the bearer's hex id, as builds before the replicated ledger kept them. Migrated and removed exactly like issuedDeviceGrants. */
  issuedDmGrants?: Record<string, string>;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).every((v) => typeof v === "string");
}

function isStoredUserIdentity(value: unknown): value is StoredUserIdentity {
  if (!isStoredIssuerKey(value)) return false;
  if (
    "issuedDeviceGrants" in value &&
    !isStringRecord(value.issuedDeviceGrants)
  )
    return false;
  if ("issuedDmGrants" in value && !isStringRecord(value.issuedDmGrants))
    return false;
  if ("ledgerWriter" in value && typeof value.ledgerWriter !== "string")
    return false;
  return true;
}

/** The directory the user identity and every other per-account file on this machine live in. */
export function userIdentityDir(
  options?: Readonly<UserIdentityOptions>,
): string {
  return options?.dir ?? path.join(os.homedir(), ".agent-comms");
}

function userIdentityFile(options?: Readonly<UserIdentityOptions>): string {
  return path.join(userIdentityDir(options), "user-identity.json");
}

function writeStoredUserIdentity(
  file: string,
  stored: Readonly<StoredUserIdentity>,
): void {
  writeIssuerRecord(file, stored);
}

/** Reads this principal's raw stored record, or undefined if the file is missing; throws if it exists but is unusable (issuer-identity-file.ts). Used by the issued-grant functions below to read-modify-write only their own field, leaving the persisted key material exactly as it is. */
function readStoredUserIdentity(file: string): StoredUserIdentity | undefined {
  return readIssuerRecord(file, isStoredUserIdentity);
}

/**
 * Loads the persisted user-principal identity, creating it on first use (issuer-identity-file.ts: exclusive create, renewal in place that keeps the issued-grant bookkeeping, an unusable file refused rather than regenerated).
 */
export function loadOrCreateUserIdentity(
  options?: Readonly<UserIdentityOptions>,
): PeerIdentity {
  return loadOrCreateIssuerIdentity(
    userIdentityFile(options),
    isStoredUserIdentity,
  );
}

/** Reads the persisted record, throwing if the principal has never been created: every ledger function below needs the key it belongs to. */
function requireStoredUserIdentity(file: string): StoredUserIdentity {
  const stored = readStoredUserIdentity(file);
  if (stored === undefined) {
    throw new Error(
      `no user identity persisted yet; call loadOrCreateUserIdentity first (${file})`,
    );
  }
  return stored;
}

/** This machine's writer nonce for the account ledger, generated and persisted on first use. Two processes racing to create it can each end up with a different one; that is harmless, since each writes its own writer log and the ledger is the union of every writer log the account key recognises. What must never happen is two machines sharing one, which is why it is not part of an exported account. */
export function loadOrCreateLedgerWriterNonce(
  options: Readonly<UserIdentityOptions> | undefined,
  generate: () => Uint8Array,
): Uint8Array<ArrayBuffer> {
  const file = userIdentityFile(options);
  const stored = requireStoredUserIdentity(file);
  if (stored.ledgerWriter !== undefined) {
    return Uint8Array.from(Buffer.from(stored.ledgerWriter, "base64"));
  }
  const nonce = Uint8Array.from(generate());
  writeStoredUserIdentity(file, {
    ...stored,
    ledgerWriter: Buffer.from(nonce).toString("base64"),
  });
  return nonce;
}

/** One grant a build before the replicated ledger recorded in user-identity.json. */
export interface LegacyIssuedGrant {
  kind: "device" | "dm";
  subject: string;
  tokenId: Uint8Array<ArrayBuffer>;
}

function legacyEntries(
  kind: LegacyIssuedGrant["kind"],
  record: Readonly<Record<string, string>> | undefined,
): LegacyIssuedGrant[] {
  return Object.entries(record ?? {}).map(([subject, encoded]) => ({
    kind,
    subject,
    tokenId: Uint8Array.from(Buffer.from(encoded, "base64")),
  }));
}

/** Every issued grant a pre-ledger build left in user-identity.json, still waiting to be migrated into the replicated ledger. Empty once migrated, or for an identity created by this build. */
export function readLegacyIssuedGrants(
  options: Readonly<UserIdentityOptions> | undefined,
): LegacyIssuedGrant[] {
  const stored = requireStoredUserIdentity(userIdentityFile(options));
  return [
    ...legacyEntries("device", stored.issuedDeviceGrants),
    ...legacyEntries("dm", stored.issuedDmGrants),
  ];
}

function withoutMigrated(
  record: Readonly<Record<string, string>> | undefined,
  kind: LegacyIssuedGrant["kind"],
  migrated: readonly Readonly<LegacyIssuedGrant>[],
): Record<string, string> | undefined {
  if (record === undefined) return undefined;
  const done = new Set(
    migrated
      .filter((grant) => grant.kind === kind)
      .map(
        (grant) =>
          `${grant.subject}:${Buffer.from(grant.tokenId).toString("base64")}`,
      ),
  );
  const remaining = Object.entries(record).filter(
    ([subject, encoded]) => !done.has(`${subject}:${encoded}`),
  );
  return remaining.length === 0 ? undefined : Object.fromEntries(remaining);
}

/** Removes exactly the given legacy grants from user-identity.json once they are in the ledger. The file is re-read first, so a grant written meanwhile by an older build still running on this machine stays for the next migration rather than being lost. */
export function clearLegacyIssuedGrants(
  options: Readonly<UserIdentityOptions> | undefined,
  migrated: readonly Readonly<LegacyIssuedGrant>[],
): void {
  const file = userIdentityFile(options);
  const { issuedDeviceGrants, issuedDmGrants, ...rest } =
    requireStoredUserIdentity(file);
  const device = withoutMigrated(issuedDeviceGrants, "device", migrated);
  const dm = withoutMigrated(issuedDmGrants, "dm", migrated);
  writeStoredUserIdentity(file, {
    ...rest,
    ...(device === undefined ? {} : { issuedDeviceGrants: device }),
    ...(dm === undefined ? {} : { issuedDmGrants: dm }),
  });
}

/** The account's PEM private key, for sealing into an export or a join. Throws if the principal has never been created. */
export function readAccountPrivateKey(
  options: Readonly<UserIdentityOptions> | undefined,
): string {
  return requireStoredUserIdentity(userIdentityFile(options)).privateKey;
}

/** Where a replaced account's record is kept when a different account is imported over it: its key is still the only one that can revoke what it issued, so it is set aside rather than destroyed. */
export function replacedUserIdentityFile(
  options: Readonly<UserIdentityOptions> | undefined,
  replaced: Readonly<PeerIdentity>,
): string {
  return path.join(
    userIdentityDir(options),
    `user-identity.replaced-${Buffer.from(replaced.deviceId).toString("hex")}.json`,
  );
}

/** Keeps `record`, the account being replaced in `currentFile`, at `replacedFile`. A record already there for the same key is from an earlier import that replaced this same account; it is overwritten with the current one, which may carry a renewed certificate, written to a temporary file and renamed into place so the set-aside record is never seen half-written; a file there that does not parse holds no usable record and is overwritten too. A record there holding a different key would be lost by overwriting it, and the file name derives from the key, so that file is damaged: CommsError ACCOUNT_SET_ASIDE_CONFLICT names both files rather than touching either. */
function setAside(
  replacedFile: string,
  record: Readonly<StoredUserIdentity>,
  currentFile: string,
): void {
  const earlier = readStoredUserIdentity(replacedFile);
  if (earlier !== undefined && earlier.privateKey !== record.privateKey) {
    throw new CommsError(
      `Cannot set aside the account in ${currentFile}: ${replacedFile} already exists and holds a different key. Move one of them away and import again.`,
      "ACCOUNT_SET_ASIDE_CONFLICT",
    );
  }
  writeIssuerRecord(replacedFile, record);
}

/**
 * Makes this machine hold the account whose PEM private key is given, the deliberate copy that lets one principal span machines. The key is re-certified here (the device-id, which is the account's identity, depends only on the key). This machine's own ledger writer nonce is kept, since it belongs to the machine, not the account. A different account already held here is moved aside to replacedUserIdentityFile first, never overwritten (see setAside for a record already set aside there); importing the account already held changes nothing. Returns the imported identity and, when one was replaced, where the old record now is.
 */
export function importAccountKey(
  options: Readonly<UserIdentityOptions> | undefined,
  privateKeyPem: string,
): { identity: PeerIdentity; replacedFile?: string } {
  const file = userIdentityFile(options);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const imported = certifyKeyPair(privateKeyPem);
  const existing = readStoredUserIdentity(file);
  if (existing === undefined) {
    writeStoredUserIdentity(file, issuerKeyRecord(imported));
    return { identity: imported };
  }
  const current = issuerPeerIdentity(existing);
  if (Buffer.from(current.deviceId).equals(Buffer.from(imported.deviceId))) {
    return { identity: current };
  }
  const replacedFile = replacedUserIdentityFile(options, current);
  setAside(replacedFile, existing, file);
  writeStoredUserIdentity(file, {
    ...issuerKeyRecord(imported),
    ...(existing.ledgerWriter === undefined
      ? {}
      : { ledgerWriter: existing.ledgerWriter }),
  });
  return { identity: imported, replacedFile };
}

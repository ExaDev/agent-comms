/**
 * A persisted grouping-issuer keypair: one locally generated key per file, the shape the user principal (user-identity.ts, agent-comms#160) and the machine identity (machine-identity.ts, agent-comms#343) both take. Neither is ever a live mesh peer, so neither needs identity-store.ts's PID-probed slot lock; the only race that matters is which process's key wins at first creation, which an exclusive ("wx") create settles.
 *
 * The key is never derived from anything about the host (platform UUIDs, serials, hostnames): those are linkable, cloned with disk images and swapped with hardware. Moving an identity to a rebuilt host is a deliberate copy of its file, the SSH host-key model.
 *
 * Each file is written with owner-only permissions (0600) inside a 0700 directory, and every write is atomic (atomic-file.ts), since another bridge may be reading the file at that moment: a reader sees a complete record or none, so a file that exists but cannot be parsed is never one of this module's own writes in progress. It is refused loudly rather than replaced with a fresh key, because replacing it silently changes the issuer's id and every peer that trusted the old one loses every device it vouched for. Fields an owning module adds beside the key material (issued-grant bookkeeping, a display name) are preserved by every write here: renewal spreads the stored record before replacing the key fields.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createFileExclusive, writeFileAtomic } from "./atomic-file.js";
import { CommsError } from "./store.js";
import {
  generateIdentity,
  certifyKeyPair,
  getCertificateFingerprint,
  deriveDeviceId,
  CERTIFICATE_VALIDITY_MS,
} from "./identity.js";
import type { PeerIdentity } from "./identity.js";

/** Renewal margin is one twelfth of the certificate's total validity period, matching identity-store.ts's own renewal margin so every identity ages out on the same schedule. */
const RENEWAL_MARGIN_FRACTION = 12;
const RENEWAL_MARGIN_MS = CERTIFICATE_VALIDITY_MS / RENEWAL_MARGIN_FRACTION;

/** Owner-only read and write: the file holds a private key. */
const IDENTITY_FILE_MODE = 0o600;
/** Owner-only directory, matching identity-store.ts's own base directory. */
const IDENTITY_DIR_MODE = 0o700;

/** The key material every issuer identity file holds. An owning module's own fields sit beside these in the same JSON object. */
export interface StoredIssuerKey {
  privateKey: string;
  certificate: string;
  expiresAt: string;
}

/** Whether value holds the key-material fields every issuer identity record carries. */
export function isStoredIssuerKey(value: unknown): value is StoredIssuerKey {
  if (typeof value !== "object" || value === null) return false;
  if (
    !("privateKey" in value) ||
    !("certificate" in value) ||
    !("expiresAt" in value)
  )
    return false;
  return (
    typeof value.privateKey === "string" &&
    typeof value.certificate === "string" &&
    typeof value.expiresAt === "string"
  );
}

/** Narrows a caught value to Node's own errno-carrying Error subtype, so a specific error code (e.g. ENOENT) can be checked without an `as` assertion. */
function isErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

/** The `code` of the error thrown when an identity file exists but cannot be used. */
export const IDENTITY_RECORD_UNUSABLE = "IDENTITY_RECORD_UNUSABLE";

/** Thrown when an identity file exists but does not hold a record this build can use. The file is left exactly as it was: replacing it would mint a new key, which changes the identity's id for every peer that knows it and discards whatever the record held beside the key. */
export class UnusableIdentityRecordError extends CommsError {
  constructor(
    /** The file that could not be used. */
    public readonly file: string,
    /** Why it could not be used, as a short clause. */
    public readonly reason: string,
    cause?: unknown,
  ) {
    super(
      `${file} exists but does not hold a usable identity record (${reason}). It has been left as it was. Restore it from a backup, or move it aside to start a new identity, which changes this identity's id for every peer that knows it.`,
      IDENTITY_RECORD_UNUSABLE,
    );
    this.name = "UnusableIdentityRecordError";
    if (cause !== undefined) this.cause = cause;
  }
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Reads the file's raw contents, or undefined if it does not exist yet. A file that exists but cannot be read (permissions, a directory in its place) is refused as unusable, never treated as absent. */
function readRawFile(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") return undefined;
    throw new UnusableIdentityRecordError(
      file,
      `it cannot be read: ${describeCause(err)}`,
      err,
    );
  }
}

/** The file's parsed record, or undefined when the file does not exist. The owning module supplies a guard for its own full record shape. Throws when the file exists but is not JSON or fails the guard (see the module comment for why that is never repaired here). */
export function readIssuerRecord<T>(
  file: string,
  guard: (value: unknown) => value is T,
): T | undefined {
  const raw = readRawFile(file);
  return raw === undefined ? undefined : parseIssuerRecord(file, raw, guard);
}

function parseIssuerRecord<T>(
  file: string,
  raw: string,
  guard: (value: unknown) => value is T,
): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new UnusableIdentityRecordError(file, "it is not valid JSON", err);
  }
  if (!guard(parsed)) {
    throw new UnusableIdentityRecordError(
      file,
      "a field is missing or is not in a form this version accepts",
    );
  }
  return parsed;
}

function serializeRecord(stored: Readonly<object>): string {
  return `${JSON.stringify(stored, null, 2)}\n`;
}

/** Replaces the file with record in full, owner-only. Callers read the current record first and spread it, so no field another writer owns is lost. */
export function writeIssuerRecord(
  file: string,
  record: Readonly<StoredIssuerKey>,
): void {
  writeFileAtomic(file, serializeRecord(record), IDENTITY_FILE_MODE);
}

/** The identity a stored key record describes: the key, its certificate, and the fingerprint and device-id derived from them. */
export function issuerPeerIdentity(
  stored: Readonly<StoredIssuerKey>,
): PeerIdentity {
  return {
    privateKey: stored.privateKey,
    certificate: stored.certificate,
    fingerprint: getCertificateFingerprint(stored.certificate),
    deviceId: deriveDeviceId(stored.privateKey),
  };
}

/** The key record that persists identity, with a fresh expiry stamp. */
export function issuerKeyRecord(
  identity: Readonly<PeerIdentity>,
): StoredIssuerKey {
  return {
    privateKey: identity.privateKey,
    certificate: identity.certificate,
    expiresAt: new Date(Date.now() + CERTIFICATE_VALIDITY_MS).toISOString(),
  };
}

/** The identity a stored record describes, or UnusableIdentityRecordError when its key or certificate cannot be read. */
function identityOfRecord(
  file: string,
  stored: Readonly<StoredIssuerKey>,
): PeerIdentity {
  try {
    return issuerPeerIdentity(stored);
  } catch (err) {
    throw new UnusableIdentityRecordError(
      file,
      `its key or certificate cannot be read: ${describeCause(err)}`,
      err,
    );
  }
}

/** Renews a stored identity nearing certificate expiry by re-certifying its existing key pair, so its device-id is unchanged (see identity.ts's certifyKeyPair for why a fresh key pair would be wrong). Every other field in the record is kept. Returns the identity unchanged when it is not yet near expiry. */
function renewIfNeeded(
  file: string,
  stored: Readonly<StoredIssuerKey>,
): PeerIdentity {
  const expiresAt = Date.parse(stored.expiresAt);
  const needsRenewal =
    Number.isNaN(expiresAt) || Date.now() > expiresAt - RENEWAL_MARGIN_MS;
  if (!needsRenewal) return identityOfRecord(file, stored);

  let renewed: PeerIdentity;
  try {
    renewed = certifyKeyPair(stored.privateKey);
  } catch (err) {
    throw new UnusableIdentityRecordError(
      file,
      `its key cannot be certified again: ${describeCause(err)}`,
      err,
    );
  }
  writeIssuerRecord(file, { ...stored, ...issuerKeyRecord(renewed) });
  return renewed;
}

/** Generates a fresh identity and persists it at file, which does not exist yet. The create is exclusive, so when a concurrent caller creates the file first this caller keeps the winner's key and returns that instead of overwriting it, judging the winner's record with the owning module's guard. */
function createIssuerIdentity(
  file: string,
  guard: (value: unknown) => value is StoredIssuerKey,
): PeerIdentity {
  const identity = generateIdentity();
  if (
    createFileExclusive(
      file,
      serializeRecord(issuerKeyRecord(identity)),
      IDENTITY_FILE_MODE,
    )
  ) {
    return identity;
  }
  const winner = readIssuerRecord(file, guard);
  if (winner === undefined) {
    throw new Error(`${file} was created and removed again while loading it`);
  }
  return renewIfNeeded(file, winner);
}

/**
 * Loads the issuer identity persisted at file, creating it on first use. A record nearing certificate expiry is renewed in place and a missing file is created exclusively. guard is the owning module's check of its full record shape, the same one its own reads use, so a record that loads here is one every later read-modify-write of that module accepts too. A file that exists but fails guard is an error, never regenerated.
 */
export function loadOrCreateIssuerIdentity(
  file: string,
  guard: (value: unknown) => value is StoredIssuerKey,
): PeerIdentity {
  fs.mkdirSync(path.dirname(file), {
    recursive: true,
    mode: IDENTITY_DIR_MODE,
  });

  const stored = readIssuerRecord(file, guard);
  if (stored === undefined) return createIssuerIdentity(file, guard);
  return renewIfNeeded(file, stored);
}

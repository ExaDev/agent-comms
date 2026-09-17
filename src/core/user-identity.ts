/**
 * Persistent user-principal identity: a single keypair scoped to this machine account rather than any one (harness, cwd) bridge slot -- the root issuer agent-comms#160 introduces, so a user principal can mint capability tokens to the devices it owns, independent of which bridge process happens to be running. See identity-store.ts for the per-slot device identity every bridge already has; this is deliberately a separate, shared identity, not a variant of it.
 *
 * Stored at ~/.agent-comms/user-identity.json (mode 0600), sibling to but distinct from any identity-<harness>--<cwd>.json slot file. No lock file: unlike a bridge identity, this key is never itself a live mesh peer that two concurrent holders would collide over on the wire, so the only race that matters is which process's key wins at first creation -- handled below by an exclusive ("wx") file create rather than identity-store.ts's PID-probed lock, which exists for a concern (a live peer-identity collision) this key never has.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  generateIdentity,
  certifyKeyPair,
  getCertificateFingerprint,
  deriveDeviceId,
  CERTIFICATE_VALIDITY_MS,
} from "./identity.js";
import type { PeerIdentity } from "./identity.js";

/** Renewal margin is one twelfth of the certificate's total validity period -- matching identity-store.ts's own renewal margin so both identities age out on the same schedule. */
const RENEWAL_MARGIN_FRACTION = 12;
const RENEWAL_MARGIN_MS = CERTIFICATE_VALIDITY_MS / RENEWAL_MARGIN_FRACTION;

export interface UserIdentityOptions {
  /** Directory override for tests -- defaults to ~/.agent-comms, the same base directory identity-store.ts's own per-slot files live in. */
  dir?: string;
}

interface StoredUserIdentity {
  privateKey: string;
  certificate: string;
  expiresAt: string;
}

function isStoredUserIdentity(value: unknown): value is StoredUserIdentity {
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

/** Narrows a caught value to Node's own errno-carrying Error subtype, so a specific error code (e.g. ENOENT, EEXIST) can be checked without an `as` assertion. */
function isErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function userIdentityFile(options?: Readonly<UserIdentityOptions>): string {
  const dir = options?.dir ?? path.join(os.homedir(), ".agent-comms");
  return path.join(dir, "user-identity.json");
}

function toPeerIdentity(stored: Readonly<StoredUserIdentity>): PeerIdentity {
  return {
    privateKey: stored.privateKey,
    certificate: stored.certificate,
    fingerprint: getCertificateFingerprint(stored.certificate),
    deviceId: deriveDeviceId(stored.privateKey),
  };
}

function persistedRecord(identity: Readonly<PeerIdentity>): StoredUserIdentity {
  return {
    privateKey: identity.privateKey,
    certificate: identity.certificate,
    expiresAt: new Date(Date.now() + CERTIFICATE_VALIDITY_MS).toISOString(),
  };
}

function serializeRecord(stored: Readonly<StoredUserIdentity>): string {
  return `${JSON.stringify(stored, null, 2)}\n`;
}

/** Reads the file's raw contents, or undefined if it does not exist yet. Any other filesystem error (permissions, a directory in its place) is surfaced rather than silently treated as "absent", per this codebase's fail-loudly convention. */
function readRawFile(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") return undefined;
    throw err;
  }
}

function parseStoredUserIdentity(raw: string): StoredUserIdentity | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return isStoredUserIdentity(parsed) ? parsed : undefined;
}

/**
 * Renews a stored identity nearing certificate expiry by re-certifying its existing key pair (preserving device-id) rather than replacing it -- see identity.ts's own certifyKeyPair doc comment for why generating a fresh key pair here would be wrong. Returns the existing identity unchanged when it is not yet near expiry.
 */
function renewIfNeeded(
  file: string,
  stored: Readonly<StoredUserIdentity>,
): PeerIdentity {
  const expiresAt = Date.parse(stored.expiresAt);
  const needsRenewal =
    Number.isNaN(expiresAt) || Date.now() > expiresAt - RENEWAL_MARGIN_MS;
  if (!needsRenewal) return toPeerIdentity(stored);

  const renewed = certifyKeyPair(stored.privateKey);
  fs.writeFileSync(file, serializeRecord(persistedRecord(renewed)), {
    encoding: "utf-8",
    mode: 0o600,
  });
  return renewed;
}

/**
 * Generates a fresh identity and persists it. When `exclusive` is true, the write uses Node's "wx" flag so a concurrent caller that already created the file loses the race outright (EEXIST) rather than silently clobbering whatever the winner just wrote -- the loser then re-reads the winner's own file instead. `exclusive` is false only when the file is known to hold no genuine key material worth protecting (it was corrupt), so there is nothing to race over and a plain overwrite is correct.
 */
function createUserIdentity(file: string, exclusive: boolean): PeerIdentity {
  const identity = generateIdentity();
  try {
    fs.writeFileSync(file, serializeRecord(persistedRecord(identity)), {
      encoding: "utf-8",
      mode: 0o600,
      flag: exclusive ? "wx" : "w",
    });
    return identity;
  } catch (err) {
    if (exclusive && isErrnoException(err) && err.code === "EEXIST") {
      const raw = readRawFile(file);
      const stored =
        raw === undefined ? undefined : parseStoredUserIdentity(raw);
      if (stored !== undefined) return renewIfNeeded(file, stored);
    }
    throw err;
  }
}

/**
 * Loads the persisted user-principal identity, creating it on first use. A record nearing certificate expiry is renewed in place; a missing, corrupt, or unparseable file is treated as absent and regenerated.
 *
 * Creation races against a concurrent caller (another bridge process starting at the same moment) by attempting an exclusive ("wx") file create: whichever process's create wins persists its own freshly generated identity, and the loser detects EEXIST and re-reads the winner's file instead of overwriting it. A corrupt file skips the exclusive path entirely -- there is no genuine key material in it worth protecting from a race, so it is overwritten directly, the same treatment identity-store.ts's own loadStoredIdentity/createIdentity pairing gives a corrupt slot file.
 */
export function loadOrCreateUserIdentity(
  options?: Readonly<UserIdentityOptions>,
): PeerIdentity {
  const file = userIdentityFile(options);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });

  const raw = readRawFile(file);
  if (raw === undefined) return createUserIdentity(file, true);

  const stored = parseStoredUserIdentity(raw);
  if (stored === undefined) return createUserIdentity(file, false);

  return renewIfNeeded(file, stored);
}

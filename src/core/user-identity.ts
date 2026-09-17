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
  /** The token-id (base64) of each group:member grant this principal has itself issued to a device it admitted (agent-comms#161), keyed by the device's own device-id in hex -- the bookkeeping the principal needs to revoke a specific device's own membership later (removeDevice), mirroring identity-store.ts's own issuedGrants field for room membership. */
  issuedDeviceGrants?: Record<string, string>;
  /** The token-id (base64) of each dm:send grant this principal has itself issued to a bearer device (agent-comms#162), keyed by the bearer's device-id hex -- the bookkeeping a user needs to revoke a specific agent's own DM access later, mirroring identity-store.ts's own issuedGrants field for room:member grants. A token-id is never presented back on the wire, so this identity's own memory of having minted it is the only record. */
  issuedDmGrants?: Record<string, string>;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).every((v) => typeof v === "string");
}

function isStoredUserIdentity(value: unknown): value is StoredUserIdentity {
  if (typeof value !== "object" || value === null) return false;
  if (
    !("privateKey" in value) ||
    !("certificate" in value) ||
    !("expiresAt" in value)
  )
    return false;
  if (
    typeof value.privateKey !== "string" ||
    typeof value.certificate !== "string" ||
    typeof value.expiresAt !== "string"
  )
    return false;
  if (
    "issuedDeviceGrants" in value &&
    !isStringRecord(value.issuedDeviceGrants)
  )
    return false;
  if ("issuedDmGrants" in value && !isStringRecord(value.issuedDmGrants))
    return false;
  return true;
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

function writeStoredUserIdentity(
  file: string,
  stored: Readonly<StoredUserIdentity>,
): void {
  fs.writeFileSync(file, serializeRecord(stored), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

/** Reads this principal's raw stored record, or undefined if the file is missing or unparseable. Used by the issued-grant functions below to read-modify-write only their own field, leaving the persisted key material exactly as it is. */
function readStoredUserIdentity(file: string): StoredUserIdentity | undefined {
  const raw = readRawFile(file);
  return raw === undefined ? undefined : parseStoredUserIdentity(raw);
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
 * Renews a stored identity nearing certificate expiry by re-certifying its existing key pair (preserving device-id) rather than replacing it -- see identity.ts's own certifyKeyPair doc comment for why generating a fresh key pair here would be wrong. Returns the existing identity unchanged when it is not yet near expiry. A plain persistedRecord() write here would silently drop this principal's own issuedDeviceGrants/issuedDmGrants (it always builds a bare privateKey/certificate/expiresAt record with nothing else) -- spreading `stored` first preserves every other field on renewal, the same fix identity-store.ts's own loadStoredIdentity/writeStoredIdentity pairing already applies for roomTokens/issuedGrants.
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
  writeStoredUserIdentity(file, { ...stored, ...persistedRecord(renewed) });
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

/**
 * The token-id this principal itself minted for the given device's own group:member grant (agent-comms#161), or undefined if none is on record (this principal has never admitted this device, or the record predates this bookkeeping). The principal consults this to revoke a specific device's own membership later -- a token-id, unlike the token itself, is never presented on the wire and so is never obtainable except from this principal's own memory of having minted it. Mirrors identity-store.ts's own loadIssuedRoomGrant.
 */
export function loadIssuedDeviceGrant(
  options: Readonly<UserIdentityOptions> | undefined,
  deviceHex: string,
): Uint8Array<ArrayBuffer> | undefined {
  const file = userIdentityFile(options);
  const stored = readStoredUserIdentity(file);
  const encoded = stored?.issuedDeviceGrants?.[deviceHex];
  return encoded === undefined
    ? undefined
    : Uint8Array.from(Buffer.from(encoded, "base64"));
}

/**
 * Records the token-id of a group:member grant this principal has just minted for deviceHex, surviving a restart the same way the principal's own key material does. Overwrites any earlier record for the same device -- a fresh admission always supersedes the grant it replaces, so only the current token-id is ever worth revoking. Mirrors identity-store.ts's own saveIssuedRoomGrant.
 */
export function saveIssuedDeviceGrant(
  options: Readonly<UserIdentityOptions> | undefined,
  deviceHex: string,
  tokenId: Uint8Array,
): void {
  const file = userIdentityFile(options);
  const stored = readStoredUserIdentity(file);
  if (stored === undefined) {
    throw new Error(
      `no user identity persisted yet -- call loadOrCreateUserIdentity first (${file})`,
    );
  }
  const issuedDeviceGrants = {
    ...stored.issuedDeviceGrants,
    [deviceHex]: Buffer.from(tokenId).toString("base64"),
  };
  writeStoredUserIdentity(file, { ...stored, issuedDeviceGrants });
}

/** Removes the recorded token-id for one device's own grant, if any -- called once a removal has revoked it, so a later re-admission mints and records a genuinely fresh one rather than leaving a stale entry alongside it. A no-op if none was recorded. Mirrors identity-store.ts's own deleteIssuedRoomGrant. */
export function deleteIssuedDeviceGrant(
  options: Readonly<UserIdentityOptions> | undefined,
  deviceHex: string,
): void {
  const file = userIdentityFile(options);
  const stored = readStoredUserIdentity(file);
  if (stored?.issuedDeviceGrants === undefined) return;
  const issuedDeviceGrants = Object.fromEntries(
    Object.entries(stored.issuedDeviceGrants).filter(([k]) => k !== deviceHex),
  );
  writeStoredUserIdentity(file, { ...stored, issuedDeviceGrants });
}

/**
 * The token-id this principal has itself minted for bearerDeviceHex's own dm:send grant (agent-comms#162), or undefined if none is on record (this principal has never admitted that device, or the record predates this bookkeeping, or the principal identity has never been created at all). A user consults this to revoke a specific agent's own DM access later -- a token-id, unlike the token itself, is never presented on the wire and so is never obtainable except from this identity's own memory of having minted it. Mirrors loadIssuedDeviceGrant above.
 */
export function loadIssuedDmGrant(
  options: Readonly<UserIdentityOptions> | undefined,
  bearerDeviceHex: string,
): Uint8Array<ArrayBuffer> | undefined {
  const file = userIdentityFile(options);
  const stored = readStoredUserIdentity(file);
  const encoded = stored?.issuedDmGrants?.[bearerDeviceHex];
  return encoded === undefined
    ? undefined
    : Uint8Array.from(Buffer.from(encoded, "base64"));
}

/**
 * Records the token-id of a dm:send grant this principal has just minted for bearerDeviceHex, surviving a restart the same way the identity itself does. Overwrites any earlier record for the same bearer -- a fresh admission always supersedes the grant it replaces, so only the current token-id is ever worth revoking. Throws if this principal has never been created (call loadOrCreateUserIdentity first). Mirrors saveIssuedDeviceGrant above.
 */
export function saveIssuedDmGrant(
  options: Readonly<UserIdentityOptions> | undefined,
  bearerDeviceHex: string,
  tokenId: Uint8Array,
): void {
  const file = userIdentityFile(options);
  const stored = readStoredUserIdentity(file);
  if (stored === undefined) {
    throw new Error(
      `no user-principal identity persisted yet -- call loadOrCreateUserIdentity first (${file})`,
    );
  }
  const issuedDmGrants = {
    ...stored.issuedDmGrants,
    [bearerDeviceHex]: Buffer.from(tokenId).toString("base64"),
  };
  writeStoredUserIdentity(file, { ...stored, issuedDmGrants });
}

/** Removes the recorded token-id for one bearer's dm:send grant, if any -- called once a revocation has taken effect, so a later re-admission mints and records a genuinely fresh one rather than leaving a stale entry alongside it. A no-op if none was recorded, or if this principal has never been created. Mirrors deleteIssuedDeviceGrant above. */
export function deleteIssuedDmGrant(
  options: Readonly<UserIdentityOptions> | undefined,
  bearerDeviceHex: string,
): void {
  const file = userIdentityFile(options);
  const stored = readStoredUserIdentity(file);
  if (stored?.issuedDmGrants === undefined) return;
  const issuedDmGrants = Object.fromEntries(
    Object.entries(stored.issuedDmGrants).filter(
      ([hex]) => hex !== bearerDeviceHex,
    ),
  );
  writeStoredUserIdentity(file, { ...stored, issuedDmGrants });
}

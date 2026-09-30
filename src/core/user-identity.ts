/**
 * Persistent user-principal identity: a single keypair scoped to this machine account rather than any one (harness, cwd) bridge slot, the root issuer agent-comms#160 introduces, so a user principal can mint capability tokens to the devices it owns, independent of which bridge process happens to be running. See identity-store.ts for the per-slot device identity every bridge already has; this is deliberately a separate, shared identity, not a variant of it.
 *
 * Stored at ~/.agent-comms/user-identity.json (mode 0600), sibling to but distinct from any identity-<harness>--<cwd>.json slot file and to the machine identity (machine-identity.ts). Loading, creation and renewal are issuer-identity-file.ts's, shared with the machine identity; this module adds the principal's own issued-grant bookkeeping to the same record.
 */

import * as os from "node:os";
import * as path from "node:path";
import type { PeerIdentity } from "./identity.js";
import {
  isStoredIssuerKey,
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
  /** The token-id (base64) of each group:member grant this principal has itself issued to a device it admitted (agent-comms#161), keyed by the device's own device-id in hex: the bookkeeping the principal needs to revoke a specific device's own membership later (removeDevice), mirroring identity-store.ts's own issuedGrants field for room membership. */
  issuedDeviceGrants?: Record<string, string>;
  /** The token-id (base64) of each dm:send grant this principal has itself issued to a bearer device (agent-comms#162), keyed by the bearer's device-id hex: the bookkeeping a user needs to revoke a specific agent's own DM access later, mirroring identity-store.ts's own issuedGrants field for room:member grants. A token-id is never presented back on the wire, so this identity's own memory of having minted it is the only record. */
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
  return true;
}

function userIdentityFile(options?: Readonly<UserIdentityOptions>): string {
  const dir = options?.dir ?? path.join(os.homedir(), ".agent-comms");
  return path.join(dir, "user-identity.json");
}

function writeStoredUserIdentity(
  file: string,
  stored: Readonly<StoredUserIdentity>,
): void {
  writeIssuerRecord(file, stored);
}

/** Reads this principal's raw stored record, or undefined if the file is missing or unparseable. Used by the issued-grant functions below to read-modify-write only their own field, leaving the persisted key material exactly as it is. */
function readStoredUserIdentity(file: string): StoredUserIdentity | undefined {
  return readIssuerRecord(file, isStoredUserIdentity);
}

/**
 * Loads the persisted user-principal identity, creating it on first use (issuer-identity-file.ts: exclusive create, renewal in place that keeps the issued-grant bookkeeping, a corrupt file regenerated).
 */
export function loadOrCreateUserIdentity(
  options?: Readonly<UserIdentityOptions>,
): PeerIdentity {
  return loadOrCreateIssuerIdentity(userIdentityFile(options));
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

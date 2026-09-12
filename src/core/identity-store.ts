/**
 * Persistent bridge identity: load-or-create the TLS key material for a (harness, cwd) slot so the device-id -- and therefore the peer and agent ID -- survives restarts. Also persists a per-room capability token set in the same slot, so a room membership grant survives a restart the same way the identity it was minted against does.
 *
 * Mesh state stays in memory and on the wire; the only thing on disk is this local credential (plus, now, the tokens minted against it), the same trust model as an SSH key. A lock file holding a PID keeps two live bridges in one slot from sharing an identity, which would put duplicate peer IDs on the mesh; the second bridge runs with an ephemeral identity (the behaviour before persistence) instead. Bridges without a graceful shutdown hook can skip releasing the lock: a stale lock is detected by probing the recorded PID, the same way the coordinator probes for stale agents.
 *
 * Persisting the key material rather than a bare agent ID is what makes restarts work: delivery routing fires when agentId === peerId, and peerId is deviceIdToHex(identity.deviceId), so an ID without its key can never match the running peer. Renewal near certificate expiry currently generates an entirely fresh key pair rather than re-certifying the existing one, which silently rotates the device-id (and so invalidates any persisted room tokens bound to it) -- a real, separately tracked gap (#68), not addressed here.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CapabilityToken } from "wire-mesh-core/generated/protocol";
import {
  generateIdentity,
  getCertificateFingerprint,
  deriveDeviceId,
  CERTIFICATE_VALIDITY_MS,
} from "./identity.js";
import type { PeerIdentity } from "./identity.js";

/** A bridge's identity slot: one persisted identity per harness and cwd. */
export interface IdentitySlot {
  harness: string;
  cwd: string;
  /** Directory override for tests. */
  dir?: string;
}

/** Renew during the final twelfth of the certificate's validity. */
const RENEWAL_MARGIN_MS = CERTIFICATE_VALIDITY_MS / 12;

/** A CapabilityToken (COSE_Sign1: [protected header bytes, unprotected header map, payload bytes or null, signature bytes]) with every byte-string field base64-encoded for JSON storage. Only the two named unprotected-header fields (alg, kid) are round-tripped -- every token minted by wire-mesh-core today leaves the unprotected header empty (alg/kid live in the protected header instead), so the schema's own open catchall for arbitrary extra keys is left unhandled until a real caller actually needs one preserved. */
type SerializedCapabilityToken = [
  string,
  { "1"?: number; "4"?: string; [key: string]: unknown },
  string | null,
  string,
];

interface StoredIdentity {
  privateKey: string;
  certificate: string;
  expiresAt: string;
  roomTokens?: Record<string, SerializedCapabilityToken>;
  /** The token-id (base64) of each room:member grant this identity has itself issued to another device, keyed by "roomPath::memberDeviceHex" -- the bookkeeping a room owner needs to revoke a specific member's own grant later (kickFromRoom), distinct from roomTokens above (which holds tokens this identity BEARS, not ones it issued). */
  issuedGrants?: Record<string, string>;
}

function isSerializedCapabilityToken(
  value: unknown,
): value is SerializedCapabilityToken {
  if (!Array.isArray(value) || value.length !== 4) return false;
  const protectedHeader: unknown = value[0];
  const unprotectedHeader: unknown = value[1];
  const payload: unknown = value[2];
  const signature: unknown = value[3];
  if (typeof protectedHeader !== "string") return false;
  if (typeof unprotectedHeader !== "object" || unprotectedHeader === null)
    return false;
  if (payload !== null && typeof payload !== "string") return false;
  return typeof signature === "string";
}

function isStoredIdentity(value: unknown): value is StoredIdentity {
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
  if ("roomTokens" in value) {
    const { roomTokens } = value;
    if (typeof roomTokens !== "object" || roomTokens === null) return false;
    if (!Object.values(roomTokens).every(isSerializedCapabilityToken))
      return false;
  }
  if ("issuedGrants" in value) {
    const { issuedGrants } = value;
    if (typeof issuedGrants !== "object" || issuedGrants === null) return false;
    if (!Object.values(issuedGrants).every((v) => typeof v === "string"))
      return false;
  }
  return true;
}

function serializeToken(token: CapabilityToken): SerializedCapabilityToken {
  const [protectedHeader, unprotectedHeader, payload, signature] = token;
  const serializedUnprotected: SerializedCapabilityToken[1] = {
    ...(unprotectedHeader["1"] !== undefined
      ? { "1": unprotectedHeader["1"] }
      : {}),
    ...(unprotectedHeader["4"] !== undefined
      ? { "4": Buffer.from(unprotectedHeader["4"]).toString("base64") }
      : {}),
  };
  return [
    Buffer.from(protectedHeader).toString("base64"),
    serializedUnprotected,
    payload === null ? null : Buffer.from(payload).toString("base64"),
    Buffer.from(signature).toString("base64"),
  ];
}

function deserializeToken(
  serialized: SerializedCapabilityToken,
): CapabilityToken {
  const [protectedHeader, unprotectedHeader, payload, signature] = serialized;
  const deserializedUnprotected: CapabilityToken[1] = {
    ...(unprotectedHeader["1"] !== undefined
      ? { "1": unprotectedHeader["1"] }
      : {}),
    ...(unprotectedHeader["4"] !== undefined
      ? {
          "4": Uint8Array.from(Buffer.from(unprotectedHeader["4"], "base64")),
        }
      : {}),
  };
  return [
    Uint8Array.from(Buffer.from(protectedHeader, "base64")),
    deserializedUnprotected,
    payload === null ? null : Uint8Array.from(Buffer.from(payload, "base64")),
    Uint8Array.from(Buffer.from(signature, "base64")),
  ];
}

/** Replace path separators and other filesystem-hostile characters. */
function slugifyCwd(cwd: string): string {
  return cwd.replace(/[\\/:*?"<>|]/g, "_");
}

function slotPaths(slot: IdentitySlot): {
  dir: string;
  identityFile: string;
  lockFile: string;
} {
  const dir = slot.dir ?? path.join(os.homedir(), ".agent-comms");
  const base = `identity-${slot.harness}--${slugifyCwd(slot.cwd)}`;
  return {
    dir,
    identityFile: path.join(dir, `${base}.json`),
    lockFile: path.join(dir, `${base}.lock`),
  };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Read the PID holding the lock, or undefined when absent or unreadable. */
function readLockPid(lockFile: string): number | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(lockFile, "utf-8");
  } catch {
    return undefined;
  }
  const pid = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(pid) ? pid : undefined;
}

function writeLock(lockFile: string): void {
  fs.writeFileSync(lockFile, `${String(process.pid)}\n`, "utf-8");
}

function persistIdentity(identityFile: string, identity: PeerIdentity): void {
  const stored: StoredIdentity = {
    privateKey: identity.privateKey,
    certificate: identity.certificate,
    expiresAt: new Date(Date.now() + CERTIFICATE_VALIDITY_MS).toISOString(),
  };
  fs.writeFileSync(identityFile, `${JSON.stringify(stored, null, 2)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
}

/**
 * Load the persisted identity for the slot, creating it on first use, and take the slot lock. Returns an ephemeral identity when the slot is already held by another live process.
 */
export function loadOrCreateIdentity(slot: IdentitySlot): PeerIdentity {
  const { dir, identityFile, lockFile } = slotPaths(slot);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const heldBy = readLockPid(lockFile);
  if (heldBy !== undefined && heldBy !== process.pid && isPidAlive(heldBy)) {
    console.error(
      `agent-comms: identity slot ${slot.harness} (${slot.cwd}) is held by live pid ${String(heldBy)}; running with an ephemeral identity`,
    );
    return generateIdentity();
  }

  const identity =
    loadStoredIdentity(identityFile) ?? createIdentity(identityFile);
  writeLock(lockFile);
  return identity;
}

/** Load and validate the stored key material, renewing near certificate expiry. */
function loadStoredIdentity(identityFile: string): PeerIdentity | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(identityFile, "utf-8"));
  } catch {
    return undefined;
  }
  if (!isStoredIdentity(parsed)) return undefined;

  const expiresAt = Date.parse(parsed.expiresAt);
  if (Number.isNaN(expiresAt) || Date.now() > expiresAt - RENEWAL_MARGIN_MS) {
    return undefined;
  }

  try {
    return {
      privateKey: parsed.privateKey,
      certificate: parsed.certificate,
      fingerprint: getCertificateFingerprint(parsed.certificate),
      deviceId: deriveDeviceId(parsed.privateKey),
    };
  } catch (err) {
    console.error(
      `agent-comms: stored identity at ${identityFile} is unreadable (${err instanceof Error ? err.message : String(err)}); generating a fresh identity`,
    );
    return undefined;
  }
}

function createIdentity(identityFile: string): PeerIdentity {
  const identity = generateIdentity();
  persistIdentity(identityFile, identity);
  return identity;
}

/**
 * Release the slot lock on graceful shutdown. A lock held by another PID (taken over after this process crashed and restarted) is left alone.
 */
export function releaseIdentityLock(slot: IdentitySlot): void {
  const { lockFile } = slotPaths(slot);
  if (readLockPid(lockFile) === process.pid) {
    fs.rmSync(lockFile, { force: true });
  }
}

/** Reads the slot's raw stored identity record, or undefined if the file is missing or unparseable. Used by the room-token functions below to read-modify-write only the roomTokens field, leaving the persisted key material exactly as it is. */
function readStoredIdentity(identityFile: string): StoredIdentity | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(identityFile, "utf-8"));
  } catch {
    return undefined;
  }
  return isStoredIdentity(parsed) ? parsed : undefined;
}

function writeStoredIdentity(
  identityFile: string,
  stored: StoredIdentity,
): void {
  fs.writeFileSync(identityFile, `${JSON.stringify(stored, null, 2)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
}

/**
 * Every room-membership capability token persisted for this slot, keyed by room path. Empty if the slot has never had one saved (or the identity file doesn't exist yet -- call loadOrCreateIdentity first).
 */
export function loadRoomTokens(
  slot: IdentitySlot,
): Record<string, CapabilityToken> {
  const { identityFile } = slotPaths(slot);
  const stored = readStoredIdentity(identityFile);
  const serialized = stored?.roomTokens ?? {};
  const tokens: Record<string, CapabilityToken> = {};
  for (const [roomPath, token] of Object.entries(serialized)) {
    tokens[roomPath] = deserializeToken(token);
  }
  return tokens;
}

/**
 * Persists a capability token for the given room path, surviving a restart the same way the identity it was minted against does. Overwrites any token already saved for that room; leaves every other room's token and the identity's own key material untouched.
 */
export function saveRoomToken(
  slot: IdentitySlot,
  roomPath: string,
  token: CapabilityToken,
): void {
  const { identityFile } = slotPaths(slot);
  const stored = readStoredIdentity(identityFile);
  if (stored === undefined) {
    throw new Error(
      `no identity persisted for this slot yet -- call loadOrCreateIdentity first (${identityFile})`,
    );
  }
  const roomTokens = {
    ...stored.roomTokens,
    [roomPath]: serializeToken(token),
  };
  writeStoredIdentity(identityFile, { ...stored, roomTokens });
}

/** Removes the persisted token for one room path, if any. A no-op if none was saved for that path. */
export function deleteRoomToken(slot: IdentitySlot, roomPath: string): void {
  const { identityFile } = slotPaths(slot);
  const stored = readStoredIdentity(identityFile);
  if (stored?.roomTokens === undefined) return;
  const roomTokens = Object.fromEntries(
    Object.entries(stored.roomTokens).filter(([path]) => path !== roomPath),
  );
  writeStoredIdentity(identityFile, { ...stored, roomTokens });
}

function issuedGrantKey(roomPath: string, memberDeviceHex: string): string {
  return `${roomPath}::${memberDeviceHex}`;
}

/**
 * The token-id this identity itself minted for the given member's room:member grant, or undefined if none is on record (the slot has never admitted this member, or the record predates this bookkeeping). A room owner consults this to revoke a specific member's own grant later -- a token-id, unlike the token itself, is never presented on the wire and so is never obtainable except from this identity's own memory of having minted it.
 */
export function loadIssuedRoomGrant(
  slot: IdentitySlot,
  roomPath: string,
  memberDeviceHex: string,
): Uint8Array<ArrayBuffer> | undefined {
  const { identityFile } = slotPaths(slot);
  const stored = readStoredIdentity(identityFile);
  const encoded =
    stored?.issuedGrants?.[issuedGrantKey(roomPath, memberDeviceHex)];
  return encoded === undefined
    ? undefined
    : Uint8Array.from(Buffer.from(encoded, "base64"));
}

/**
 * Records the token-id of a room:member grant this identity has just minted for memberDeviceHex in roomPath, surviving a restart the same way roomTokens does. Overwrites any earlier record for the same (roomPath, member) pair -- a fresh join/invite always supersedes the grant it replaces, so only the current token-id is ever worth revoking.
 */
export function saveIssuedRoomGrant(
  slot: IdentitySlot,
  roomPath: string,
  memberDeviceHex: string,
  tokenId: Uint8Array,
): void {
  const { identityFile } = slotPaths(slot);
  const stored = readStoredIdentity(identityFile);
  if (stored === undefined) {
    throw new Error(
      `no identity persisted for this slot yet -- call loadOrCreateIdentity first (${identityFile})`,
    );
  }
  const issuedGrants = {
    ...stored.issuedGrants,
    [issuedGrantKey(roomPath, memberDeviceHex)]:
      Buffer.from(tokenId).toString("base64"),
  };
  writeStoredIdentity(identityFile, { ...stored, issuedGrants });
}

/** Removes the recorded token-id for one (roomPath, member) grant, if any -- called once a kick has revoked it, so a later re-join mints and records a genuinely fresh one rather than leaving a stale entry alongside it. A no-op if none was recorded. */
export function deleteIssuedRoomGrant(
  slot: IdentitySlot,
  roomPath: string,
  memberDeviceHex: string,
): void {
  const { identityFile } = slotPaths(slot);
  const stored = readStoredIdentity(identityFile);
  if (stored?.issuedGrants === undefined) return;
  const key = issuedGrantKey(roomPath, memberDeviceHex);
  const issuedGrants = Object.fromEntries(
    Object.entries(stored.issuedGrants).filter(([k]) => k !== key),
  );
  writeStoredIdentity(identityFile, { ...stored, issuedGrants });
}

/**
 * Persistent bridge identity: load-or-create the TLS key material for a (harness, cwd) slot so the device-id -- and therefore the peer and agent ID -- survives restarts. Also persists a per-room capability token set in the same slot, so a room membership grant survives a restart the same way the identity it was minted against does. Also persists a slot's own trusted-gateway device-id set (agent-comms#186) in a sibling JSON file, so GatewayTrust's allowlist survives a restart the same way; unlike the room/group tokens above, this doesn't require an identity to already exist for the slot, since the trusted set has no dependency on this slot's own key material.
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
  certifyKeyPair,
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

/** Renewal margin is one twelfth of the certificate's total validity period. */
const RENEWAL_MARGIN_FRACTION = 12;
/** Renew during the final twelfth of the certificate's validity. */
const RENEWAL_MARGIN_MS = CERTIFICATE_VALIDITY_MS / RENEWAL_MARGIN_FRACTION;

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
  /** This device's own held group:member token(s) (agent-comms#161), keyed by group path (the admitting user principal's own device-id in hex, core/user-identity.ts's own userGroupPath) -- the device-membership counterpart of roomTokens above, holding a token this identity BEARS proving the user principal admitted it, never one it issued itself (a device is never the issuer of its own membership). */
  groupTokens?: Record<string, SerializedCapabilityToken>;
}

/** A COSE_Sign1 tuple always has exactly 4 elements: protected header, unprotected header, payload, signature. */
const COSE_SIGN1_TUPLE_LENGTH = 4;

function isSerializedCapabilityToken(
  value: unknown,
): value is SerializedCapabilityToken {
  if (!Array.isArray(value) || value.length !== COSE_SIGN1_TUPLE_LENGTH)
    return false;
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
  if ("groupTokens" in value) {
    const { groupTokens } = value;
    if (typeof groupTokens !== "object" || groupTokens === null) return false;
    if (!Object.values(groupTokens).every(isSerializedCapabilityToken))
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

function slotPaths(slot: Readonly<IdentitySlot>): {
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

/** Directory this slot's own room-notice oplog is stored under (createNodeFsStorage's own dir option), mirroring the identity file's per-(harness, cwd) naming convention -- a sibling directory rather than a sibling file, since an oplog needs its own directory tree (one entry per sequence number) rather than a single JSON blob. */
export function oplogDirFor(slot: Readonly<IdentitySlot>): string {
  const { dir } = slotPaths(slot);
  const base = `oplog-${slot.harness}--${slugifyCwd(slot.cwd)}`;
  return path.join(dir, base);
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
export function loadOrCreateIdentity(
  slot: Readonly<IdentitySlot>,
): PeerIdentity {
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

/**
 * Load and validate the stored key material. A well-formed record nearing certificate expiry is renewed by re-certifying its existing key pair (preserving device-id) rather than replaced -- see `certifyKeyPair`'s own doc comment for why generating a fresh key pair here would be wrong. Returns undefined only when there is no usable existing key pair to renew at all (missing, unparseable, or corrupt), which is the caller's signal to generate an entirely new identity instead.
 */
function loadStoredIdentity(identityFile: string): PeerIdentity | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(identityFile, "utf-8"));
  } catch {
    return undefined;
  }
  if (!isStoredIdentity(parsed)) return undefined;

  const expiresAt = Date.parse(parsed.expiresAt);
  const needsRenewal =
    Number.isNaN(expiresAt) || Date.now() > expiresAt - RENEWAL_MARGIN_MS;

  try {
    if (needsRenewal) {
      const renewed = certifyKeyPair(parsed.privateKey);
      // A plain persistIdentity() call here would silently drop this slot's roomTokens/issuedGrants (it always writes a bare {privateKey, certificate, expiresAt} record) -- write through writeStoredIdentity instead so a renewal preserves everything else already on record, the same way saveRoomToken/saveIssuedRoomGrant already do for their own fields.
      writeStoredIdentity(identityFile, {
        ...parsed,
        privateKey: renewed.privateKey,
        certificate: renewed.certificate,
        expiresAt: new Date(Date.now() + CERTIFICATE_VALIDITY_MS).toISOString(),
      });
      return renewed;
    }
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
 * Probes a slot's current lock holder without taking it -- the cc-peer front (agent-comms#157) uses this read-only check to decide whether a local Claude Code session already fronts itself (a live agent-comms bridge already holds the slot) before attaching, and to notice a session's own bridge taking the slot over later so the front can yield. Returns the live PID currently holding the slot's lock, or undefined when the slot is unlocked or its recorded holder is no longer alive.
 */
export function probeSlotOwner(
  slot: Readonly<IdentitySlot>,
): number | undefined {
  const { lockFile } = slotPaths(slot);
  const heldBy = readLockPid(lockFile);
  if (heldBy === undefined) return undefined;
  return isPidAlive(heldBy) ? heldBy : undefined;
}

/**
 * Loads (creating on first use) the persisted identity for a slot without taking its exclusivity lock. The cc-peer front (agent-comms#157) uses this to assume a not-yet-live session's own future identity, so the device-id -- and with it every agent id, room membership, and pending delivery already addressed to it -- carries over unchanged the moment that session's own bridge starts and claims the slot for real. Callers must have already confirmed via probeSlotOwner that no live bridge currently holds the slot; re-probing atomically against a concurrent acquisition isn't possible across the two separate files (identity vs lock) this store keeps, so it's the front's own periodic re-probe, not this function, that detects and reacts to a real bridge taking over afterwards.
 */
export function loadIdentityForFront(
  slot: Readonly<IdentitySlot>,
): PeerIdentity {
  const { dir, identityFile } = slotPaths(slot);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return loadStoredIdentity(identityFile) ?? createIdentity(identityFile);
}

/**
 * Release the slot lock on graceful shutdown. A lock held by another PID (taken over after this process crashed and restarted) is left alone.
 */
export function releaseIdentityLock(slot: Readonly<IdentitySlot>): void {
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
  slot: Readonly<IdentitySlot>,
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
  slot: Readonly<IdentitySlot>,
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
export function deleteRoomToken(
  slot: Readonly<IdentitySlot>,
  roomPath: string,
): void {
  const { identityFile } = slotPaths(slot);
  const stored = readStoredIdentity(identityFile);
  if (stored?.roomTokens === undefined) return;
  const roomTokens = Object.fromEntries(
    Object.entries(stored.roomTokens).filter(
      ([storedRoomPath]) => storedRoomPath !== roomPath,
    ),
  );
  writeStoredIdentity(identityFile, { ...stored, roomTokens });
}

/**
 * Every group-membership capability token this device's own identity holds (agent-comms#161), keyed by group path. Empty if this slot has never saved one (or the identity file doesn't exist yet -- call loadOrCreateIdentity first). The device-membership counterpart of loadRoomTokens.
 */
export function loadGroupTokens(
  slot: Readonly<IdentitySlot>,
): Record<string, CapabilityToken> {
  const { identityFile } = slotPaths(slot);
  const stored = readStoredIdentity(identityFile);
  const serialized = stored?.groupTokens ?? {};
  const tokens: Record<string, CapabilityToken> = {};
  for (const [groupPath, token] of Object.entries(serialized)) {
    tokens[groupPath] = deserializeToken(token);
  }
  return tokens;
}

/**
 * Persists this device's own group:member token for the given group path, surviving a restart the same way the identity it was minted against does. Overwrites any token already saved for that group path; leaves every other group's token and the identity's own key material untouched. The device-membership counterpart of saveRoomToken.
 */
export function saveGroupToken(
  slot: Readonly<IdentitySlot>,
  groupPath: string,
  token: CapabilityToken,
): void {
  const { identityFile } = slotPaths(slot);
  const stored = readStoredIdentity(identityFile);
  if (stored === undefined) {
    throw new Error(
      `no identity persisted for this slot yet -- call loadOrCreateIdentity first (${identityFile})`,
    );
  }
  const groupTokens = {
    ...stored.groupTokens,
    [groupPath]: serializeToken(token),
  };
  writeStoredIdentity(identityFile, { ...stored, groupTokens });
}

/** Removes the persisted token for one group path, if any. A no-op if none was saved for that path. The device-membership counterpart of deleteRoomToken. */
export function deleteGroupToken(
  slot: Readonly<IdentitySlot>,
  groupPath: string,
): void {
  const { identityFile } = slotPaths(slot);
  const stored = readStoredIdentity(identityFile);
  if (stored?.groupTokens === undefined) return;
  const groupTokens = Object.fromEntries(
    Object.entries(stored.groupTokens).filter(
      ([storedGroupPath]) => storedGroupPath !== groupPath,
    ),
  );
  writeStoredIdentity(identityFile, { ...stored, groupTokens });
}

function issuedGrantKey(roomPath: string, memberDeviceHex: string): string {
  return `${roomPath}::${memberDeviceHex}`;
}

/**
 * The token-id this identity itself minted for the given member's room:member grant, or undefined if none is on record (the slot has never admitted this member, or the record predates this bookkeeping). A room owner consults this to revoke a specific member's own grant later -- a token-id, unlike the token itself, is never presented on the wire and so is never obtainable except from this identity's own memory of having minted it.
 */
export function loadIssuedRoomGrant(
  slot: Readonly<IdentitySlot>,
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
  slot: Readonly<IdentitySlot>,
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
  slot: Readonly<IdentitySlot>,
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

/** A slot's own trusted-gateway allowlist (agent-comms#186) lives in its own sibling JSON file rather than inside the identity file: the trusted set has no dependency on this slot's own key material, so it doesn't share loadRoomTokens/saveRoomToken's "call loadOrCreateIdentity first" requirement, and GatewayTrust can be constructed against a slot before or independently of that slot's identity ever being loaded. */
function gatewayTrustFilePath(slot: Readonly<IdentitySlot>): string {
  const { dir } = slotPaths(slot);
  const base = `gateway-trust-${slot.harness}--${slugifyCwd(slot.cwd)}`;
  return path.join(dir, `${base}.json`);
}

/** loadGatewayTrust's own return shape: every remote device-id and every remote user-principal device-id (agent-comms#187) this slot's gateway currently trusts, each lowercase hex, in insertion order. */
export interface LoadedGatewayTrust {
  devices: string[];
  principals: string[];
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

/**
 * The trusted devices and principals (agent-comms#187) a slot's gateway had persisted before this call, both empty if the slot has never saved a trusted set or its gateway trust file is missing or unparseable. Reads a pre-#187 file (a bare JSON array, agent-comms#186's own original format) as devices-only with no principals -- every gateway-trust file written before principal-keyed trust existed named only bare devices, so there is nothing to migrate, just an older, narrower shape to keep reading correctly.
 */
export function loadGatewayTrust(
  slot: Readonly<IdentitySlot>,
): LoadedGatewayTrust {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(gatewayTrustFilePath(slot), "utf-8"));
  } catch {
    return { devices: [], principals: [] };
  }
  if (isStringArray(parsed)) return { devices: parsed, principals: [] };
  if (typeof parsed !== "object" || parsed === null) {
    return { devices: [], principals: [] };
  }
  const devices =
    "devices" in parsed && isStringArray(parsed.devices) ? parsed.devices : [];
  const principals =
    "principals" in parsed && isStringArray(parsed.principals)
      ? parsed.principals
      : [];
  return { devices, principals };
}

/**
 * Persists a slot's complete trusted-gateway device-id and principal-id sets (agent-comms#187 extends agent-comms#186's own original device-only persistence, per that issue's own "agent-comms#187 covers what gets stored" framing), surviving a restart the same way the identity they gate alongside does. Overwrites whatever was saved before in full: GatewayTrust always calls this with its own current list()/listPrincipals() after every add/remove/addPrincipal/removePrincipal, so there is no per-entry partial update to preserve here the way saveRoomToken preserves other rooms' tokens.
 */
export function saveGatewayTrust(
  slot: Readonly<IdentitySlot>,
  devices: readonly string[],
  principals: readonly string[],
): void {
  const { dir } = slotPaths(slot);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stored: LoadedGatewayTrust = {
    devices: [...devices],
    principals: [...principals],
  };
  fs.writeFileSync(
    gatewayTrustFilePath(slot),
    `${JSON.stringify(stored, null, 2)}\n`,
    { encoding: "utf-8", mode: 0o600 },
  );
}

/** A generated connection code's own persisted record (agent-comms#188): everything ConnectionCode carries except its own nonce, which is this record's key instead of a repeated field. */
export interface StoredConnectionCode {
  expiresAt: string;
  deviceId: string;
  signature?: string;
}

/** A slot's own connection-code ledger (agent-comms#188): every code this slot has generated (still outstanding, so the artifact survives a restart between generation and hand-off) and every nonce this slot has redeemed (so a restart can't reopen a single-use code to a second redemption within its own short validity window). Two independent halves of one bootstrap flow, not a request/response pair -- a generated code's own record here is never consulted by whichever remote slot later redeems it, since redemption validates the code's four self-contained fields directly rather than calling back to its issuer. */
export interface ConnectionCodeLedgerData {
  issued: Record<string, StoredConnectionCode>;
  redeemed: Record<string, string>;
}

/** A slot's own connection-code ledger lives in its own sibling JSON file, mirroring gatewayTrustFilePath's own reasoning: the ledger has no dependency on this slot's own key material, so ConnectionCodeLedger can be constructed against a slot before or independently of that slot's identity ever being loaded. */
function connectionCodesFilePath(slot: Readonly<IdentitySlot>): string {
  const { dir } = slotPaths(slot);
  const base = `connection-codes-${slot.harness}--${slugifyCwd(slot.cwd)}`;
  return path.join(dir, `${base}.json`);
}

function isStoredConnectionCode(value: unknown): value is StoredConnectionCode {
  if (typeof value !== "object" || value === null) return false;
  if (!("expiresAt" in value) || !("deviceId" in value)) return false;
  if (typeof value.expiresAt !== "string" || typeof value.deviceId !== "string")
    return false;
  if ("signature" in value && typeof value.signature !== "string")
    return false;
  return true;
}

/**
 * A slot's currently persisted connection-code ledger: every code it has issued, keyed by nonce, and every nonce it has redeemed, mapped to that code's own expiresAt (kept only so a stale entry can be pruned once its expiry has passed, the same reason issued entries carry their own expiresAt). Both halves default to empty if the slot has never saved a ledger, or its ledger file is missing or unparseable.
 */
export function loadConnectionCodeLedger(
  slot: Readonly<IdentitySlot>,
): ConnectionCodeLedgerData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      fs.readFileSync(connectionCodesFilePath(slot), "utf-8"),
    );
  } catch {
    return { issued: {}, redeemed: {} };
  }
  if (typeof parsed !== "object" || parsed === null)
    return { issued: {}, redeemed: {} };
  const issuedRaw =
    "issued" in parsed && typeof parsed.issued === "object" &&
    parsed.issued !== null
      ? parsed.issued
      : {};
  const redeemedRaw =
    "redeemed" in parsed && typeof parsed.redeemed === "object" &&
    parsed.redeemed !== null
      ? parsed.redeemed
      : {};
  const issued: Record<string, StoredConnectionCode> = {};
  for (const [nonce, record] of Object.entries(issuedRaw)) {
    if (isStoredConnectionCode(record)) issued[nonce] = record;
  }
  const redeemed: Record<string, string> = {};
  for (const [nonce, expiresAt] of Object.entries(redeemedRaw)) {
    if (typeof expiresAt === "string") redeemed[nonce] = expiresAt;
  }
  return { issued, redeemed };
}

/**
 * Persists a slot's complete connection-code ledger, surviving a restart the same way the identity it bootstraps trust for does. Overwrites whatever was saved before in full: ConnectionCodeLedger always calls this with its own current issued/redeemed maps after every generate/redeem, so there is no per-code partial update to preserve here the way saveRoomToken preserves other rooms' tokens.
 */
export function saveConnectionCodeLedger(
  slot: Readonly<IdentitySlot>,
  ledger: Readonly<ConnectionCodeLedgerData>,
): void {
  const { dir } = slotPaths(slot);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    connectionCodesFilePath(slot),
    `${JSON.stringify(ledger, null, 2)}\n`,
    { encoding: "utf-8", mode: 0o600 },
  );
}

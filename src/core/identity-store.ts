/**
 * Persistent bridge identity: load-or-create the TLS key material for a (harness, cwd) slot so the device-id -- and therefore the peer and agent ID -- survives restarts. Also persists a per-room capability token set in the same slot, so a room membership grant survives a restart the same way the identity it was minted against does. Also persists a slot's own trusted-gateway device-id set (agent-comms#186) in a sibling JSON file, so GatewayTrust's allowlist survives a restart the same way; unlike the room/group tokens above, this doesn't require an identity to already exist for the slot, since the trusted set has no dependency on this slot's own key material.
 *
 * Mesh state stays in memory and on the wire; the only thing on disk is this local credential (plus, now, the tokens minted against it), the same trust model as an SSH key. A lock file holding a PID keeps two live bridges in one slot from sharing an identity, which would put duplicate peer IDs on the mesh; the second bridge runs with an ephemeral identity (the behaviour before persistence) instead. Bridges without a graceful shutdown hook can skip releasing the lock: a stale lock is detected by probing the recorded PID, the same way the coordinator probes for stale agents.
 *
 * Persisting the key material rather than a bare agent ID is what makes restarts work: delivery routing fires when agentId === peerId, and peerId is deviceIdToHex(identity.deviceId), so an ID without its key can never match the running peer. Renewal near certificate expiry re-certifies the existing key pair, so the device-id survives it. A slot file that exists but cannot be used is never replaced: loading it throws UnusableIdentityRecordError (issuer-identity-file.ts), because a new key would silently change the peer id and discard every token the file holds. Only a missing file starts a new identity.
 *
 * Several processes can write one slot file: the bridge holding the slot lock, a cc-peer front loading the same identity without that lock, and whichever of them is renewing the certificate. Every read-modify-write of the file therefore runs under a short-lived write lock of its own (the slot lock is held for the bridge's whole lifetime, so it cannot serialise them). A bridge that lost the slot lock runs under an identity that is not the file's, so the tokens it mints and holds are kept in its own memory for the life of the process and never read from or written to the file.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  resolveDataDir,
  type DataDirectoryLocation,
} from "./data-directory.js";
import type { CapabilityToken } from "wire-mesh-core/generated/protocol";
import { generateIdentity } from "./identity.js";
import { isIsoTimestamp } from "./iso-timestamp.js";
import type { PeerIdentity } from "./identity.js";
import { writeFileAtomic } from "./atomic-file.js";
import {
  loadOrCreateIssuerIdentity,
  readIssuerRecord,
  type StoredIssuerKey,
} from "./issuer-identity-file.js";
import {
  isPidAlive,
  readLockPid,
  releaseLockFile,
  tryAcquireLock,
  withWriteLockAsync,
} from "./pid-lock-file.js";

/** A bridge's identity slot: one persisted identity per harness and cwd. */
export interface IdentitySlot extends DataDirectoryLocation {
  harness: string;
  cwd: string;
  /** Directory override for tests. */
  dir?: string;
}

/** A persisted identity/token/trust/ledger file holds real key material or capability tokens, so it is written owner-only. */
const OWNER_ONLY_RW_PERMISSIONS = 0o600;

/** A CapabilityToken (COSE_Sign1: [protected header bytes, unprotected header map, payload bytes or null, signature bytes]) with every byte-string field base64-encoded for JSON storage. Only the two named unprotected-header fields (alg, kid) are round-tripped -- every token minted by wire-mesh-core today leaves the unprotected header empty (alg/kid live in the protected header instead), so the schema's own open catchall for arbitrary extra keys is left unhandled until a real caller actually needs one preserved. */
export type SerializedCapabilityToken = [
  string,
  { "1"?: number; "4"?: string; [key: string]: unknown },
  string | null,
  string,
];

/** What a slot remembers beside its key material: the tokens it bears or has issued. */
interface SlotTokenRecords {
  roomTokens?: Record<string, SerializedCapabilityToken>;
  /** The token-id (base64) of each room:member grant this identity has itself issued to another device, keyed by "roomPath::memberDeviceHex" -- the bookkeeping a room owner needs to revoke a specific member's own grant later (kickFromRoom), distinct from roomTokens above (which holds tokens this identity BEARS, not ones it issued). */
  issuedGrants?: Record<string, string>;
  /** This device's own held group:member token(s) (agent-comms#161), keyed by group path (the admitting user principal's own device-id in hex, core/user-identity.ts's own userGroupPath) -- the device-membership counterpart of roomTokens above, holding a token this identity BEARS proving the user principal admitted it, never one it issued itself (a device is never the issuer of its own membership). */
  groupTokens?: Record<string, SerializedCapabilityToken>;
}

interface StoredIdentity extends StoredIssuerKey, SlotTokenRecords {}

/** A COSE_Sign1 tuple always has exactly 4 elements: protected header, unprotected header, payload, signature. */
const COSE_SIGN1_TUPLE_LENGTH = 4;

export function isSerializedCapabilityToken(
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

/** A capability token as plain JSON: every byte string base64-encoded. */
export function serializeToken(
  token: CapabilityToken,
): SerializedCapabilityToken {
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

/** The inverse of serializeToken. */
export function deserializeToken(
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

/** The directory every file this module owns lives in. */
function identityDir(
  location: Readonly<Pick<IdentitySlot, "dir" | "dataDir">>,
): string {
  return resolveDataDir({ dir: location.dataDir ?? location.dir });
}

function slotPaths(slot: Readonly<IdentitySlot>): {
  dir: string;
  identityFile: string;
  lockFile: string;
} {
  const dir = identityDir(slot);
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

/** The token records of every slot this process runs under an identity that is not the slot file's (it lost the slot lock to another live process), keyed by the slot's file. They are bound to a throw-away device-id, so they live and die with the process: neither written into the winner's file nor read from it. */
const ephemeralTokenRecords = new Map<string, SlotTokenRecords>();

/** Loads the identity the slot file holds, creating it when the file does not exist, renewing it in place near certificate expiry. Throws UnusableIdentityRecordError, leaving the file untouched, when the file exists but cannot be used. */
function loadSlotIdentity(
  paths: Readonly<ReturnType<typeof slotPaths>>,
): PeerIdentity {
  return loadOrCreateIssuerIdentity(paths.identityFile, isStoredIdentity);
}

/**
 * Load the persisted identity for the slot, creating it on first use, and take the slot lock. Returns an ephemeral identity when the slot is already held by another live process.
 *
 * Throws UnusableIdentityRecordError when the slot's file exists but cannot be used (damaged, unreadable, or holding a key that cannot be certified again). The file is left untouched, the slot lock is released and no identity is returned: a caller must not join the mesh under a key the user did not choose, so the bridge stops with the error's message, which says what to do.
 */
export function loadOrCreateIdentity(
  slot: Readonly<IdentitySlot>,
): PeerIdentity {
  const paths = slotPaths(slot);
  const { dir, identityFile, lockFile } = paths;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const claim = tryAcquireLock(lockFile);
  if (!claim.acquired) {
    console.error(
      `agent-comms: identity slot ${slot.harness} (${slot.cwd}) is held by live pid ${String(claim.heldBy)}; running with an ephemeral identity`,
    );
    ephemeralTokenRecords.set(identityFile, {});
    return generateIdentity();
  }
  ephemeralTokenRecords.delete(identityFile);

  try {
    return loadSlotIdentity(paths);
  } catch (err) {
    releaseLockFile(lockFile);
    throw err;
  }
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
 * Loads (creating on first use) the persisted identity for a slot without taking its exclusivity lock. Throws UnusableIdentityRecordError exactly as loadOrCreateIdentity does, and the front reports it for that session without fronting it. The cc-peer front (agent-comms#157) uses this to assume a not-yet-live session's own future identity, so the device-id, and with it every agent id, room membership, and pending delivery already addressed to it, carries over unchanged the moment that session's own bridge starts and claims the slot for real. Callers must have already confirmed via probeSlotOwner that no live bridge currently holds the slot; re-probing atomically against a concurrent acquisition isn't possible across the two separate files (identity vs lock) this store keeps, so it's the front's own periodic re-probe, not this function, that detects and reacts to a real bridge taking over afterwards.
 */
export function loadIdentityForFront(
  slot: Readonly<IdentitySlot>,
): PeerIdentity {
  const paths = slotPaths(slot);
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  ephemeralTokenRecords.delete(paths.identityFile);
  return loadSlotIdentity(paths);
}

/**
 * Release the slot lock on graceful shutdown. A lock held by another PID (taken over after this process crashed and restarted) is left alone.
 */
export function releaseIdentityLock(slot: Readonly<IdentitySlot>): void {
  releaseLockFile(slotPaths(slot).lockFile);
}

/** Reads the slot's raw stored identity record, or undefined if the file is missing or unparseable. Only for reads that treat "no usable record" as "no tokens", which grants nothing; every write goes through updateTokenRecords, which refuses an unusable file instead. */
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
  writeFileAtomic(
    identityFile,
    `${JSON.stringify(stored, null, 2)}\n`,
    OWNER_ONLY_RW_PERMISSIONS,
  );
}

// Total time to wait for a concurrent lock holder to finish creating the slot's identity file before giving up. loadOrCreateIdentity always finishes creating the file before any other process can observe its lock as taken (tryAcquireLock is the very first thing it does), so a caller that lost that race and is left holding an ephemeral identity may still reach here before the winner's own creation (a keygen plus one atomic write) has completed, 2s is generously above that real cost even on a loaded machine, while still bounded so a holder that crashed mid-creation doesn't wedge this call forever.
const CONCURRENT_CREATE_WAIT_MS = 2000;
// Poll interval while waiting -- deliberately short, since the wait is expected to resolve in low single-digit milliseconds in the overwhelmingly common case.
const CONCURRENT_CREATE_POLL_MS = 10;

/**
 * Waits briefly for the slot's identity file to appear if it doesn't exist yet but a different live process currently holds the slot's lock, that process is, by construction, in the middle of creating it (see loadOrCreateIdentity/tryAcquireLock), so a caller racing as this slot's own loser should wait for the real winner to finish rather than fail outright. Returns once the file exists, or once the lock is no longer held by a different live process, or the wait budget runs out, the last two signal there is genuinely nothing to wait for.
 */
async function waitForConcurrentCreate(
  identityFile: string,
  lockFile: string,
): Promise<void> {
  const deadline = Date.now() + CONCURRENT_CREATE_WAIT_MS;
  for (;;) {
    if (fs.existsSync(identityFile)) return;

    const heldBy = readLockPid(lockFile);
    const heldByDifferentLiveProcess =
      heldBy !== undefined && heldBy !== process.pid && isPidAlive(heldBy);
    if (!heldByDifferentLiveProcess || Date.now() >= deadline) return;

    await new Promise<void>((resolve) => {
      setTimeout(resolve, CONCURRENT_CREATE_POLL_MS);
    });
  }
}

/** The token records a slot currently holds for this process: its own in-memory records when it runs under an identity that is not the slot file's, otherwise those in the file (none when the file is missing or unusable). */
function readTokenRecords(identityFile: string): SlotTokenRecords {
  return (
    ephemeralTokenRecords.get(identityFile) ??
    readStoredIdentity(identityFile) ??
    {}
  );
}

/**
 * Applies `change` to the slot's token records and persists the result, leaving the key material exactly as it is. The read and the write happen under the slot file's write lock, so two processes updating different tokens cannot drop each other's update. A slot running under a non-file identity keeps the change in this process's memory only.
 *
 * With `requireIdentity`, throws when the slot has no identity file yet (waiting briefly for a concurrent creator first); otherwise a missing file is a no-op. Either way a file that exists but cannot be used throws UnusableIdentityRecordError and is not written.
 */
async function updateTokenRecords(
  slot: Readonly<IdentitySlot>,
  change: (records: Readonly<SlotTokenRecords>) => SlotTokenRecords | undefined,
  requireIdentity: boolean,
): Promise<void> {
  const { identityFile, lockFile } = slotPaths(slot);
  const ephemeral = ephemeralTokenRecords.get(identityFile);
  if (ephemeral !== undefined) {
    ephemeralTokenRecords.set(identityFile, {
      ...ephemeral,
      ...change(ephemeral),
    });
    return;
  }
  if (requireIdentity) await waitForConcurrentCreate(identityFile, lockFile);
  await withWriteLockAsync(identityFile, () => {
    const stored = readIssuerRecord(identityFile, isStoredIdentity);
    if (stored === undefined) {
      if (requireIdentity) {
        throw new Error(
          `no identity persisted for this slot yet, call loadOrCreateIdentity first (${identityFile})`,
        );
      }
      return;
    }
    const changed = change(stored);
    if (changed !== undefined) {
      writeStoredIdentity(identityFile, { ...stored, ...changed });
    }
  });
}

/**
 * Every room-membership capability token persisted for this slot, keyed by room path. Empty if the slot has never had one saved (or the identity file doesn't exist yet -- call loadOrCreateIdentity first).
 */
export function loadRoomTokens(
  slot: Readonly<IdentitySlot>,
): Record<string, CapabilityToken> {
  const { identityFile } = slotPaths(slot);
  const serialized = readTokenRecords(identityFile).roomTokens ?? {};
  const tokens: Record<string, CapabilityToken> = {};
  for (const [roomPath, token] of Object.entries(serialized)) {
    tokens[roomPath] = deserializeToken(token);
  }
  return tokens;
}

/**
 * Persists a capability token for the given room path, surviving a restart the same way the identity it was minted against does. Overwrites any token already saved for that room; leaves every other room's token and the identity's own key material untouched. A slot running under an ephemeral identity keeps it in this process's memory only.
 */
export async function saveRoomToken(
  slot: Readonly<IdentitySlot>,
  roomPath: string,
  token: CapabilityToken,
): Promise<void> {
  await updateTokenRecords(
    slot,
    (records) => ({
      roomTokens: { ...records.roomTokens, [roomPath]: serializeToken(token) },
    }),
    true,
  );
}

/** Removes the persisted token for one room path, if any. A no-op if none was saved for that path. */
export async function deleteRoomToken(
  slot: Readonly<IdentitySlot>,
  roomPath: string,
): Promise<void> {
  await updateTokenRecords(
    slot,
    (records) =>
      records.roomTokens === undefined
        ? undefined
        : {
            roomTokens: Object.fromEntries(
              Object.entries(records.roomTokens).filter(
                ([storedRoomPath]) => storedRoomPath !== roomPath,
              ),
            ),
          },
    false,
  );
}

/**
 * Every group-membership capability token this device's own identity holds (agent-comms#161), keyed by group path. Empty if this slot has never saved one (or the identity file doesn't exist yet -- call loadOrCreateIdentity first). The device-membership counterpart of loadRoomTokens.
 */
export function loadGroupTokens(
  slot: Readonly<IdentitySlot>,
): Record<string, CapabilityToken> {
  const { identityFile } = slotPaths(slot);
  const serialized = readTokenRecords(identityFile).groupTokens ?? {};
  const tokens: Record<string, CapabilityToken> = {};
  for (const [groupPath, token] of Object.entries(serialized)) {
    tokens[groupPath] = deserializeToken(token);
  }
  return tokens;
}

/**
 * Persists this device's own group:member token for the given group path, surviving a restart the same way the identity it was minted against does. Overwrites any token already saved for that group path; leaves every other group's token and the identity's own key material untouched. The device-membership counterpart of saveRoomToken.
 */
export async function saveGroupToken(
  slot: Readonly<IdentitySlot>,
  groupPath: string,
  token: CapabilityToken,
): Promise<void> {
  await updateTokenRecords(
    slot,
    (records) => ({
      groupTokens: {
        ...records.groupTokens,
        [groupPath]: serializeToken(token),
      },
    }),
    true,
  );
}

/** Removes the persisted token for one group path, if any. A no-op if none was saved for that path. The device-membership counterpart of deleteRoomToken. */
export async function deleteGroupToken(
  slot: Readonly<IdentitySlot>,
  groupPath: string,
): Promise<void> {
  await updateTokenRecords(
    slot,
    (records) =>
      records.groupTokens === undefined
        ? undefined
        : {
            groupTokens: Object.fromEntries(
              Object.entries(records.groupTokens).filter(
                ([storedGroupPath]) => storedGroupPath !== groupPath,
              ),
            ),
          },
    false,
  );
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
  const encoded =
    readTokenRecords(identityFile).issuedGrants?.[
      issuedGrantKey(roomPath, memberDeviceHex)
    ];
  return encoded === undefined
    ? undefined
    : Uint8Array.from(Buffer.from(encoded, "base64"));
}

/**
 * Records the token-id of a room:member grant this identity has just minted for memberDeviceHex in roomPath, surviving a restart the same way roomTokens does. Overwrites any earlier record for the same (roomPath, member) pair -- a fresh join/invite always supersedes the grant it replaces, so only the current token-id is ever worth revoking.
 */
export async function saveIssuedRoomGrant(
  slot: Readonly<IdentitySlot>,
  roomPath: string,
  memberDeviceHex: string,
  tokenId: Uint8Array,
): Promise<void> {
  await updateTokenRecords(
    slot,
    (records) => ({
      issuedGrants: {
        ...records.issuedGrants,
        [issuedGrantKey(roomPath, memberDeviceHex)]:
          Buffer.from(tokenId).toString("base64"),
      },
    }),
    true,
  );
}

/** Removes the recorded token-id for one (roomPath, member) grant, if any -- called once a kick has revoked it, so a later re-join mints and records a genuinely fresh one rather than leaving a stale entry alongside it. A no-op if none was recorded. */
export async function deleteIssuedRoomGrant(
  slot: Readonly<IdentitySlot>,
  roomPath: string,
  memberDeviceHex: string,
): Promise<void> {
  const key = issuedGrantKey(roomPath, memberDeviceHex);
  await updateTokenRecords(
    slot,
    (records) =>
      records.issuedGrants === undefined
        ? undefined
        : {
            issuedGrants: Object.fromEntries(
              Object.entries(records.issuedGrants).filter(([k]) => k !== key),
            ),
          },
    false,
  );
}

/** The trusted-gateway allowlist lives in one JSON file per identity directory, not per bridge slot: who may see and reach this user's agents from another machine is an operator decision about the machine, and every store on it, including each session the default cc-peer front handles, advertises itself under it. It sits beside the identity files rather than inside one, because the trusted set has no dependency on any slot's key material and GatewayTrust can be constructed before an identity is ever loaded. */
function gatewayTrustFilePath(
  location: Readonly<Pick<IdentitySlot, "dir" | "dataDir">>,
): string {
  return path.join(identityDir(location), "gateway-trust.json");
}

/** The persisted trusted sets: every remote device-id, every remote user-principal device-id (agent-comms#187) and every remote machine device-id (agent-comms#343) this machine's gateway currently trusts, each lowercase hex, in insertion order. */
export interface LoadedGatewayTrust {
  devices: string[];
  principals: string[];
  machines: string[];
}

/** What gatewayTrustStamp reports while no trust file exists. */
const GATEWAY_TRUST_ABSENT_STAMP = "absent";

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

/**
 * The trusted devices, principals (agent-comms#187) and machines (agent-comms#343) persisted for this identity directory before this call, each empty if nothing has been saved or the file is missing or unparseable. A file written before machines were trusted has no machines list and loads with an empty one.
 */
export function loadGatewayTrust(
  location: Readonly<Pick<IdentitySlot, "dir" | "dataDir">>,
): LoadedGatewayTrust {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      fs.readFileSync(gatewayTrustFilePath(location), "utf-8"),
    );
  } catch {
    return { devices: [], principals: [], machines: [] };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { devices: [], principals: [], machines: [] };
  }
  const devices =
    "devices" in parsed && isStringArray(parsed.devices) ? parsed.devices : [];
  const principals =
    "principals" in parsed && isStringArray(parsed.principals)
      ? parsed.principals
      : [];
  const machines =
    "machines" in parsed && isStringArray(parsed.machines)
      ? parsed.machines
      : [];
  return { devices, principals, machines };
}

/**
 * Persists the complete trusted device, principal and machine sets for this identity directory, surviving a restart. Overwrites whatever was saved before in full: GatewayTrust calls this with its own current sets after every change, having first reloaded the file if another process replaced it, so there is no per-entry partial update to preserve here.
 */
export function saveGatewayTrust(
  location: Readonly<Pick<IdentitySlot, "dir" | "dataDir">>,
  trust: Readonly<LoadedGatewayTrust>,
): void {
  const dir = identityDir(location);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stored: LoadedGatewayTrust = {
    devices: [...trust.devices],
    principals: [...trust.principals],
    machines: [...trust.machines],
  };
  writeFileAtomic(
    gatewayTrustFilePath(location),
    `${JSON.stringify(stored, null, 2)}\n`,
    OWNER_ONLY_RW_PERMISSIONS,
  );
}

/**
 * A token that changes whenever the gateway trust file is replaced, or is created or removed, by any process: the file's inode, modification time and size, or a fixed marker while it does not exist. Every save goes through writeFileAtomic, a rename, so each write yields a new inode and the token differs even when two writes land within one timestamp tick. GatewayTrust compares it to notice that another bridge on the machine changed the shared allowlist.
 */
export function gatewayTrustStamp(
  location: Readonly<Pick<IdentitySlot, "dir" | "dataDir">>,
): string {
  try {
    const stat = fs.statSync(gatewayTrustFilePath(location));
    return `${String(stat.ino)}:${String(stat.mtimeMs)}:${String(stat.size)}`;
  } catch {
    return GATEWAY_TRUST_ABSENT_STAMP;
  }
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
  // A record whose expiry names no instant could never be pruned or honoured, so it is not loaded.
  if (!isIsoTimestamp(value.expiresAt)) return false;
  if ("signature" in value && typeof value.signature !== "string") return false;
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
    "issued" in parsed &&
    typeof parsed.issued === "object" &&
    parsed.issued !== null
      ? parsed.issued
      : {};
  const redeemedRaw =
    "redeemed" in parsed &&
    typeof parsed.redeemed === "object" &&
    parsed.redeemed !== null
      ? parsed.redeemed
      : {};
  const issued: Record<string, StoredConnectionCode> = {};
  for (const [nonce, record] of Object.entries(issuedRaw)) {
    if (isStoredConnectionCode(record)) issued[nonce] = record;
  }
  const redeemed: Record<string, string> = {};
  for (const [nonce, expiresAt] of Object.entries(redeemedRaw)) {
    if (typeof expiresAt === "string" && isIsoTimestamp(expiresAt)) {
      redeemed[nonce] = expiresAt;
    }
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
  writeFileAtomic(
    connectionCodesFilePath(slot),
    `${JSON.stringify(ledger, null, 2)}\n`,
    OWNER_ONLY_RW_PERMISSIONS,
  );
}

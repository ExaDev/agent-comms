/**
 * The confidentiality layer of the account's replicated grant ledger (agent-comms#344). A `core/data` entry is opaque bytes to the transport and is replicated to whoever asks for it, so every ledger entry is sealed with a key only a holder of the account's private key can derive: AES-256-GCM under an HKDF-SHA256 key from the account key, with the log it belongs to and its sequence number bound in as associated data so a relayer can neither read an entry nor move one to another log or position. The same derivation gives each machine's writer log an id that any account holder recognises and nobody else can distinguish from a random device-id.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createPrivateKey,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { DeviceId } from "wire-mesh-core/generated/protocol";

/** AES-256 takes a 256-bit key. */
const KEY_BYTES = 32;
/** The 96-bit IV GCM is specified for; any other length is hashed into one, which weakens its guarantees. */
const IV_BYTES = 12;
/** GCM's full-length authentication tag. */
const TAG_BYTES = 16;
/** The first byte of every sealed entry, so a later format can be told apart from this one. */
const SEALED_ENTRY_VERSION = 1;
const VERSION_BYTES = 1;
/** A data-domain log id is a device-id, which is a SHA-256 digest. */
export const WRITER_LOG_ID_BYTES = 32;
/** The random half of a writer log id; the other half authenticates it. */
export const WRITER_NONCE_BYTES = WRITER_LOG_ID_BYTES / 2;
/** A sequence number is bound into the associated data as a 64-bit big-endian integer. */
const SEQ_BYTES = 8;

const ENTRY_KEY_INFO = "agent-comms/account-ledger/entry/v1";
const WRITER_KEY_INFO = "agent-comms/account-ledger/writer/v1";
const ASSOCIATED_DATA_LABEL = "agent-comms/account-ledger/v1";

/** The two keys every ledger operation needs, derived once from the account's private key. */
export interface AccountLedgerKeys {
  /** Seals and opens entries. */
  entryKey: Buffer;
  /** Derives and recognises writer log ids. */
  writerKey: Buffer;
}

/** Derives the ledger's keys from the account's PEM private key. Every copy of the same account key derives the same keys, which is what lets every machine holding it read what any of them wrote. */
export function deriveAccountLedgerKeys(
  accountPrivateKeyPem: string,
): AccountLedgerKeys {
  const ikm = createPrivateKey(accountPrivateKeyPem).export({
    format: "der",
    type: "pkcs8",
  });
  const derive = (info: string): Buffer =>
    Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), info, KEY_BYTES));
  return {
    entryKey: derive(ENTRY_KEY_INFO),
    writerKey: derive(WRITER_KEY_INFO),
  };
}

function writerTag(writerKey: Buffer, nonce: Uint8Array): Buffer {
  return createHmac("sha256", writerKey)
    .update(nonce)
    .digest()
    .subarray(0, WRITER_LOG_ID_BYTES - WRITER_NONCE_BYTES);
}

/** A fresh random writer nonce, generated once per machine. */
export function generateWriterNonce(): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(randomBytes(WRITER_NONCE_BYTES));
}

/** The log id a machine with this writer nonce appends the account's ledger entries under: the nonce followed by a truncated HMAC of it under the account's writer key. */
export function writerLogId(
  keys: Readonly<AccountLedgerKeys>,
  nonce: Uint8Array,
): DeviceId {
  if (nonce.length !== WRITER_NONCE_BYTES) {
    throw new Error(
      `a writer nonce is ${String(WRITER_NONCE_BYTES)} bytes, got ${String(nonce.length)}`,
    );
  }
  const id = new Uint8Array(WRITER_LOG_ID_BYTES);
  id.set(nonce, 0);
  id.set(writerTag(keys.writerKey, nonce), WRITER_NONCE_BYTES);
  return id;
}

/** Whether a log id is one of this account's writer logs. Only a holder of the account key can tell; to anyone else it is indistinguishable from a device-id. */
export function isWriterLogId(
  keys: Readonly<AccountLedgerKeys>,
  logId: Uint8Array,
): boolean {
  if (logId.length !== WRITER_LOG_ID_BYTES) return false;
  const expected = writerTag(
    keys.writerKey,
    logId.subarray(0, WRITER_NONCE_BYTES),
  );
  return timingSafeEqual(expected, logId.subarray(WRITER_NONCE_BYTES));
}

function associatedData(logId: Uint8Array, seq: number): Buffer {
  const seqBytes = Buffer.alloc(SEQ_BYTES);
  seqBytes.writeBigUInt64BE(BigInt(seq));
  return Buffer.concat([Buffer.from(ASSOCIATED_DATA_LABEL), logId, seqBytes]);
}

/** Seals one ledger entry's plaintext for position `seq` of log `logId`: version, IV, tag, then ciphertext. */
export function sealLedgerEntry(
  keys: Readonly<AccountLedgerKeys>,
  logId: Uint8Array,
  seq: number,
  plaintext: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keys.entryKey, iv);
  cipher.setAAD(associatedData(logId, seq));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Uint8Array.from(
    Buffer.concat([
      Buffer.from([SEALED_ENTRY_VERSION]),
      iv,
      cipher.getAuthTag(),
      ciphertext,
    ]),
  );
}

/** Opens a sealed entry, or returns undefined if it was not sealed by a holder of this account key for exactly this log and position (tampered, moved, truncated, or someone else's). */
export function openLedgerEntry(
  keys: Readonly<AccountLedgerKeys>,
  logId: Uint8Array,
  seq: number,
  sealed: Uint8Array,
): Uint8Array<ArrayBuffer> | undefined {
  const headerBytes = VERSION_BYTES + IV_BYTES + TAG_BYTES;
  if (sealed.length < headerBytes || sealed[0] !== SEALED_ENTRY_VERSION) {
    return undefined;
  }
  const iv = sealed.subarray(VERSION_BYTES, VERSION_BYTES + IV_BYTES);
  const tag = sealed.subarray(VERSION_BYTES + IV_BYTES, headerBytes);
  const decipher = createDecipheriv("aes-256-gcm", keys.entryKey, iv);
  decipher.setAAD(associatedData(logId, seq));
  decipher.setAuthTag(tag);
  try {
    return Uint8Array.from(
      Buffer.concat([
        decipher.update(sealed.subarray(headerBytes)),
        decipher.final(),
      ]),
    );
  } catch {
    return undefined;
  }
}

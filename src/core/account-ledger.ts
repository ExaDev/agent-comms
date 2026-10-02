/**
 * The account's issued-grant ledger as a replicated object (agent-comms#344), following wire-mesh's replicated issuer grant ledger pattern (spec/PATTERNS.md). A token-id never appears on the wire except inside the grant it names, so the only record that a grant exists is what its issuer kept; with the ledger in one machine's user-identity.json, only that machine could revoke what it minted. Here every grant the account's user principal mints, and every revocation of one, is an entry in a `core/data` log, and the logs replicate by data-domain fan-out to every machine holding the account key, so any of them sees every admission and can revoke it.
 *
 * Each machine appends to a writer log of its own rather than all of them sharing one: a data-domain log is single-writer, and two machines appending to one log while apart would both write the same sequence number and fork it, silently losing one side's grants. A writer log's id is self-authenticating (account-ledger-crypto.ts), so any account holder recognises every writer log it is offered without a roster, and the ledger is the union of all of them.
 *
 * Holding a replica grants no authority: an entry is sealed under a key derived from the account key, so a replica held by anyone else is ciphertext they can neither read nor forge, and minting or revoking still needs the account's private key.
 */

import {
  decode as cborDecode,
  encode as cborEncode,
  cdeEncodeOptions,
} from "cbor2";
import { z } from "zod";
import {
  handleDataEntries,
  handleDataHave,
  handleDataRequest,
  headSeqFor,
  readEntries,
} from "wire-mesh-core/domain/data-sync";
import {
  deviceIdFromHex,
  deviceIdToHex,
} from "wire-mesh-core/domain/device-id";
import {
  revocationEntrySchema,
  type DataEntriesFrame,
  type DataHaveFrame,
  type DataRequestFrame,
  type DeviceId,
  type RevocationEntry,
} from "wire-mesh-core/generated/protocol";
import type { RevocationView } from "wire-mesh-core/domain/revocation-view";
import type { Clock } from "wire-mesh-core/ports/clock";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import type { KeyValueStorage } from "wire-mesh-core/ports/storage";
import {
  deriveAccountLedgerKeys,
  isWriterLogId,
  openLedgerEntry,
  sealLedgerEntry,
  writerLogId,
  type AccountLedgerKeys,
} from "./account-ledger-crypto.js";
import { DATA_ENTRIES_RESPONSE_LIMIT } from "./data-frame-routing.js";
import type { LedgerLock } from "./ledger-lock.js";

/** Which of the principal's grant kinds an entry is about: a device's own group:member admission (device-membership.ts), or a dm:send grant (room-lifecycle.ts, dm-send-delegation.ts). Each kind is keyed by the grant's bearer, so the two never share a namespace. */
export type IssuedGrantKind = "device" | "dm";

const LEDGER_RECORD_VERSION = 1;

const bytesSchema = z.instanceof(Uint8Array);
const kindSchema = z.enum(["device", "dm"]);

const grantRecordSchema = z
  .object({
    v: z.literal(LEDGER_RECORD_VERSION),
    op: z.literal("grant"),
    kind: kindSchema,
    subject: z.string(),
    tokenId: bytesSchema,
    at: z.number(),
  })
  .strict();

const revokeRecordSchema = z
  .object({
    v: z.literal(LEDGER_RECORD_VERSION),
    op: z.literal("revoke"),
    kind: kindSchema,
    subject: z.string(),
    tokenId: bytesSchema,
    at: z.number(),
    revocation: revocationEntrySchema,
  })
  .strict();

const ledgerRecordSchema = z.discriminatedUnion("op", [
  grantRecordSchema,
  revokeRecordSchema,
]);

type LedgerRecord = z.infer<typeof ledgerRecordSchema>;

/** One grant the ledger records as issued and not revoked. */
export interface OutstandingGrant {
  tokenId: Uint8Array<ArrayBuffer>;
  /** When it was recorded (epoch ms, the recording machine's clock). */
  at: number;
}

export interface AccountLedgerDeps {
  /** The account's PEM private key: every ledger key is derived from it. */
  accountPrivateKey: string;
  /** This machine's writer nonce, persisted once per machine (user-identity.ts). */
  writerNonce: Uint8Array;
  /** Holds every account writer log this machine has, its own included. Shared by every bridge on the machine. */
  storage: KeyValueStorage;
  /** Serialises every read and write of `storage` across every bridge sharing it: appends to this machine's writer log, replicated entries stored for another machine's, and every read of either. The store's writes are not atomic (a file is truncated, then written), so a read racing another bridge's write could see an empty head and treat a log as empty. */
  lock: LedgerLock;
  clock: Clock;
}

/** Answers and stores the data-domain frames for the account's writer logs; what a transport needs of the ledger to replicate it. */
export interface AccountLedgerReplica {
  /** Whether `peer` names one of this account's writer logs. */
  ownsLog: (peer: DeviceId) => boolean;
  /** Answers a have or request for an account log, or stores entries for one after checking every entry was sealed for exactly that log and position. Returns the frame to send back, or null for none. */
  handleDataFrame: (
    frame: Readonly<DataHaveFrame | DataRequestFrame | DataEntriesFrame>,
  ) => Promise<DataHaveFrame | DataRequestFrame | DataEntriesFrame | null>;
  /** A data-have for every account log this machine holds, to offer peers. */
  announcements: () => Promise<DataHaveFrame[]>;
}

const versionProbeSchema = z.object({ v: z.number() });

const HEAD_KEY_PATTERN = /^data\/([0-9a-f]+)\/head$/;

export class AccountLedger implements AccountLedgerReplica {
  /** This machine's own writer log. */
  readonly writerLog: DeviceId;
  private readonly keys: AccountLedgerKeys;
  private readonly revocationListeners = new Set<
    (entry: RevocationEntry) => void
  >();

  constructor(private readonly deps: Readonly<AccountLedgerDeps>) {
    this.keys = deriveAccountLedgerKeys(deps.accountPrivateKey);
    this.writerLog = writerLogId(this.keys, deps.writerNonce);
  }

  /** Records that the principal minted `tokenId` for `subjectHex`. */
  async recordGrant(
    kind: IssuedGrantKind,
    subjectHex: string,
    tokenId: Uint8Array<ArrayBuffer>,
  ): Promise<void> {
    await this.append([
      {
        v: LEDGER_RECORD_VERSION,
        op: "grant",
        kind,
        subject: subjectHex,
        tokenId,
        at: this.deps.clock.now(),
      },
    ]);
  }

  /** Records grants migrated from a pre-ledger user-identity.json in one append, so a restart part-way through leaves nothing half-recorded worth caring about: a grant recorded twice folds to one. */
  async recordGrants(
    grants: readonly Readonly<{
      kind: IssuedGrantKind;
      subject: string;
      tokenId: Uint8Array<ArrayBuffer>;
    }>[],
  ): Promise<void> {
    const at = this.deps.clock.now();
    await this.append(
      grants.map((grant) => ({
        v: LEDGER_RECORD_VERSION,
        op: "grant",
        kind: grant.kind,
        subject: grant.subject,
        tokenId: grant.tokenId,
        at,
      })),
    );
  }

  /** Records the revocation of `tokenId`, carrying the signed revocation entry itself so every replica can feed it into its own RevocationView. */
  async recordRevocation(
    kind: IssuedGrantKind,
    subjectHex: string,
    tokenId: Uint8Array<ArrayBuffer>,
    revocation: RevocationEntry,
  ): Promise<void> {
    await this.append([
      {
        v: LEDGER_RECORD_VERSION,
        op: "revoke",
        kind,
        subject: subjectHex,
        tokenId,
        at: this.deps.clock.now(),
        revocation,
      },
    ]);
  }

  /** Every grant of `kind` for `subjectHex` that some machine of the account recorded and none has revoked, oldest first. */
  async outstandingGrants(
    kind: IssuedGrantKind,
    subjectHex: string,
  ): Promise<OutstandingGrant[]> {
    const granted = new Map<string, OutstandingGrant>();
    const revoked = new Set<string>();
    for (const record of await this.records()) {
      if (record.kind !== kind || record.subject !== subjectHex) continue;
      const key = Buffer.from(record.tokenId).toString("hex");
      if (record.op === "revoke") {
        revoked.add(key);
      } else if (!granted.has(key)) {
        granted.set(key, {
          tokenId: Uint8Array.from(record.tokenId),
          at: record.at,
        });
      }
    }
    return [...granted]
      .filter(([key]) => !revoked.has(key))
      .map(([, grant]) => grant)
      .sort((a, b) => a.at - b.at);
  }

  /** Every revocation entry the ledger holds, from every machine, for a RevocationView to learn at start-up. */
  async revocations(): Promise<RevocationEntry[]> {
    return (await this.records()).flatMap((record) =>
      record.op === "revoke" ? [record.revocation] : [],
    );
  }

  ownsLog(peer: DeviceId): boolean {
    return isWriterLogId(this.keys, peer);
  }

  /** Calls `listener` with each revocation entry another machine's replicated log brings in, so a RevocationView learns it even if the gossiped revocation-announce never reached this node. Returns the unsubscribe. */
  onReplicatedRevocation(
    listener: (entry: RevocationEntry) => void,
  ): () => void {
    this.revocationListeners.add(listener);
    return () => {
      this.revocationListeners.delete(listener);
    };
  }

  async announcements(): Promise<DataHaveFrame[]> {
    return this.deps.lock.run(async () => {
      const frames: DataHaveFrame[] = [];
      for (const log of await this.heldLogs()) {
        frames.push({
          type: "data-have",
          peer: log,
          "head-seq": await headSeqFor(this.deps.storage, log),
        });
      }
      return frames;
    });
  }

  async handleDataFrame(
    frame: Readonly<DataHaveFrame | DataRequestFrame | DataEntriesFrame>,
  ): Promise<DataHaveFrame | DataRequestFrame | DataEntriesFrame | null> {
    const { storage, lock } = this.deps;
    if (frame.type === "data-have") {
      return lock.run(async () => handleDataHave(storage, frame));
    }
    if (frame.type === "data-request") {
      return lock.run(async () =>
        handleDataRequest(storage, frame, DATA_ENTRIES_RESPONSE_LIMIT),
      );
    }
    // Every entry must open for exactly its log and position before any is stored: a forged or moved entry would otherwise take a sequence number the real one can then never fill.
    const firstSeq = frame["from-seq"] + 1;
    const opened = frame.entries.map((entry, index) =>
      openLedgerEntry(this.keys, frame.peer, firstSeq + index, entry),
    );
    const plaintexts = opened.filter((plaintext) => plaintext !== undefined);
    if (plaintexts.length !== opened.length) return null;
    const stored = await lock.run(async () =>
      handleDataEntries(storage, frame),
    );
    if (!stored.ok) return null;
    for (const plaintext of plaintexts) {
      const record = decodeRecord(plaintext);
      if (record?.op !== "revoke") continue;
      for (const listener of this.revocationListeners) {
        listener(record.revocation);
      }
    }
    return null;
  }

  private async append(records: readonly LedgerRecord[]): Promise<void> {
    await this.deps.lock.run(async () => {
      const head = await headSeqFor(this.deps.storage, this.writerLog);
      const entries = records.map((record, index) =>
        sealLedgerEntry(
          this.keys,
          this.writerLog,
          head + 1 + index,
          Uint8Array.from(cborEncode(record, cdeEncodeOptions)),
        ),
      );
      await handleDataEntries(this.deps.storage, {
        type: "data-entries",
        peer: this.writerLog,
        "from-seq": head,
        entries,
      });
    });
  }

  /** Every account writer log in storage, this machine's own included once it has written anything. Called only under the lock. */
  private async heldLogs(): Promise<DeviceId[]> {
    const logs: DeviceId[] = [];
    for (const key of await this.deps.storage.keys("data/")) {
      const match = HEAD_KEY_PATTERN.exec(key);
      if (match?.[1] === undefined) continue;
      const log = deviceIdFromHex(match[1]);
      if (this.ownsLog(log)) logs.push(log);
    }
    return logs;
  }

  /** Every record in every held writer log. Throws on an entry that does not open: handleDataFrame and append never store one, so it means the storage was damaged outside the ledger, and carrying on would hide grants that can then never be revoked. */
  private async records(): Promise<LedgerRecord[]> {
    const held = await this.deps.lock.run(async () =>
      Promise.all(
        (await this.heldLogs()).map(async (log) => ({
          log,
          entries: await readEntries(this.deps.storage, log, 0),
        })),
      ),
    );
    const records: LedgerRecord[] = [];
    for (const { log, entries } of held) {
      entries.forEach((sealed, index) => {
        const seq = index + 1;
        const plaintext = openLedgerEntry(this.keys, log, seq, sealed);
        if (plaintext === undefined) {
          throw new Error(
            `account ledger entry ${String(seq)} of writer log ${deviceIdToHex(log)} does not open under this account's key`,
          );
        }
        const record = decodeRecord(plaintext);
        if (record !== undefined) records.push(record);
      });
    }
    return records;
  }
}

/** The record a sealed entry's plaintext holds, or undefined for a record of a later format version than this build knows, written by a newer build on another machine. A record claiming this build's version that does not match its schema throws: it can only be damage. */
function decodeRecord(plaintext: Uint8Array): LedgerRecord | undefined {
  const decoded: unknown = cborDecode(plaintext);
  const probe = versionProbeSchema.parse(decoded);
  if (probe.v !== LEDGER_RECORD_VERSION) return undefined;
  return ledgerRecordSchema.parse(decoded);
}

/** Feeds every revocation the account ledger holds, and each one another machine's log brings in later, into a store's RevocationView, so a grant any machine of the account revoked is refused there even if the gossiped revocation-announce never reached it. A revocation that fails to verify, or a ledger that cannot be read, is reported rather than recorded. Returns the unsubscribe, for a store that replaces its ledger on joining another account. */
export function followLedgerRevocations(
  identity: Readonly<{
    accountLedger: AccountLedger;
    revocation: RevocationView;
    identity: IdentityPort;
  }>,
  onError: (error: Error) => void,
): () => void {
  const report = (error: unknown): void => {
    onError(error instanceof Error ? error : new Error(String(error)));
  };
  const learn = (entry: RevocationEntry): void => {
    identity.revocation
      .record(entry, { identity: identity.identity })
      .then((verdict) => {
        if (!verdict.ok) {
          report(
            new Error(
              `account ledger revocation did not verify: ${verdict.reason}`,
            ),
          );
        }
      }, report);
  };
  const unsubscribe = identity.accountLedger.onReplicatedRevocation(learn);
  identity.accountLedger.revocations().then((entries) => {
    entries.forEach(learn);
  }, report);
  return unsubscribe;
}

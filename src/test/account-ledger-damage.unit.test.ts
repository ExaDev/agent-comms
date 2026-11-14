/**
 * One unreadable entry in the account ledger never stops the rest of it being read, so listing outstanding grants and removing a device still work, and every unreadable entry is reported by log and position each time it is met.
 */

import { encode as cborEncode, cdeEncodeOptions } from "cbor2";
import { describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "wire-mesh-core/adapters/memory-storage";
import { createSystemClock } from "wire-mesh-core/adapters/system-clock";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { createRevocationView } from "wire-mesh-core/domain/revocation-view";
import {
  deriveAccountLedgerKeys,
  generateWriterNonce,
  sealLedgerEntry,
} from "../core/account-ledger-crypto.js";
import {
  AccountLedger,
  LedgerEntryDamagedError,
  UNDECODABLE_REASON,
  damagedEntryReporter,
} from "../core/account-ledger.js";
import { removeDevice } from "../core/device-membership.js";
import { generateIdentity } from "../core/identity.js";
import { createInProcessLedgerLock } from "../core/ledger-lock.js";
import { randomId } from "../core/random-id.js";
import { toIdentityPort } from "../core/wire-mesh-identity.js";

const GRANTED_ENTRIES = 3;
/** Bytes that are not the start of any CBOR item the ledger writes. */
const NOT_CBOR = new Uint8Array(Buffer.from("ffffff", "hex"));

/** A fresh random id typed as the plain-buffer bytes the ledger and its storage take. */
function freshId(): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(randomId());
}
const DAMAGED_SEQ = 2;

/** A ledger over its own storage that has recorded one device grant per subject, in order, and whatever it reports as unreadable. */
async function ledgerWithGrants(subjects: readonly string[]): Promise<{
  ledger: AccountLedger;
  storage: ReturnType<typeof createMemoryStorage>;
  account: ReturnType<typeof generateIdentity>;
  reports: LedgerEntryDamagedError[];
  tokenIds: Uint8Array<ArrayBuffer>[];
}> {
  const account = generateIdentity();
  const storage = createMemoryStorage();
  const reports: LedgerEntryDamagedError[] = [];
  const ledger = new AccountLedger({
    accountPrivateKey: account.privateKey,
    writerNonce: generateWriterNonce(),
    storage,
    lock: createInProcessLedgerLock(),
    clock: createSystemClock(),
    onDamagedEntry: (error) => {
      reports.push(error);
    },
  });
  const tokenIds: Uint8Array<ArrayBuffer>[] = [];
  for (const subject of subjects) {
    const tokenId = freshId();
    tokenIds.push(tokenId);
    await ledger.recordGrant("device", subject, tokenId);
  }
  return { ledger, storage, account, reports, tokenIds };
}

/** The storage key of the entry at `seq` of the ledger's only log. */
async function entryKey(
  storage: Readonly<ReturnType<typeof createMemoryStorage>>,
  seq: number,
): Promise<string> {
  const keys = (await storage.keys("data/"))
    .filter((key) => !key.endsWith("/head"))
    .sort();
  expect(keys).toHaveLength(GRANTED_ENTRIES);
  const key = keys[seq - 1];
  if (key === undefined) throw new Error(`no entry ${String(seq)}`);
  return key;
}

const DAMAGE: readonly (readonly [
  string,
  (
    account: ReturnType<typeof generateIdentity>,
    ledger: AccountLedger,
  ) => Uint8Array<ArrayBuffer>,
])[] = [
  ["bytes that do not open under the account key", () => freshId()],
  [
    "a sealed entry that is not CBOR",
    (account, ledger) =>
      sealLedgerEntry(
        deriveAccountLedgerKeys(account.privateKey),
        ledger.writerLog,
        DAMAGED_SEQ,
        NOT_CBOR,
      ),
  ],
  [
    "a sealed entry of this format version that does not match its schema",
    (account, ledger) =>
      sealLedgerEntry(
        deriveAccountLedgerKeys(account.privateKey),
        ledger.writerLog,
        DAMAGED_SEQ,
        Uint8Array.from(cborEncode({ v: 1, op: "grant" }, cdeEncodeOptions)),
      ),
  ],
];

describe("an unreadable entry in the account ledger", () => {
  it.each(DAMAGE.slice(1))(
    "is reported with fixed text, never the decoder's own message: %s",
    async (_name, damage) => {
      const { ledger, storage, account, reports } = await ledgerWithGrants([
        "device-a",
        "device-b",
        "device-c",
      ]);
      await storage.set(
        await entryKey(storage, DAMAGED_SEQ),
        damage(account, ledger),
      );

      await ledger.outstandingGrants("device", "device-a");

      expect(reports[0]?.reason).toBe(UNDECODABLE_REASON);
    },
  );

  it.each(DAMAGE)(
    "does not stop the other grants being listed, and is reported: %s",
    async (_name, damage) => {
      const { ledger, storage, account, reports, tokenIds } =
        await ledgerWithGrants(["device-a", "device-b", "device-c"]);
      await storage.set(
        await entryKey(storage, DAMAGED_SEQ),
        damage(account, ledger),
      );

      const first = await ledger.outstandingGrants("device", "device-a");
      const third = await ledger.outstandingGrants("device", "device-c");
      const hidden = await ledger.outstandingGrants("device", "device-b");

      expect(first.map((grant) => grant.tokenId)).toEqual([tokenIds[0]]);
      expect(third.map((grant) => grant.tokenId)).toEqual([tokenIds[2]]);
      // A grant recorded only in the unreadable entry cannot be listed, which is why the entry is reported.
      expect(hidden).toEqual([]);
      // Three reads met the entry; it is reported once.
      expect(reports).toHaveLength(1);
      expect(reports[0]).toBeInstanceOf(LedgerEntryDamagedError);
      expect(reports[0]).toMatchObject({
        log: deviceIdToHex(ledger.writerLog),
        seq: DAMAGED_SEQ,
      });
      expect(reports[0]?.message).toContain("is not read");
    },
  );

  it("is reported to stderr when no handler is given", async () => {
    const account = generateIdentity();
    const storage = createMemoryStorage();
    const ledger = new AccountLedger({
      accountPrivateKey: account.privateKey,
      writerNonce: generateWriterNonce(),
      storage,
      lock: createInProcessLedgerLock(),
      clock: createSystemClock(),
    });
    await ledger.recordGrant("device", "device-a", freshId());
    await storage.set(await entryKeyOfOne(storage), freshId());

    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      await ledger.outstandingGrants("device", "device-a");
      const written = write.mock.calls.map(([chunk]) => String(chunk)).join("");
      expect(written).toContain("cannot be read");
    } finally {
      write.mockRestore();
    }
  });

  it("is reported to the store's error handler once it has one, and to stderr until then", () => {
    let onError: ((error: Error) => void) | undefined;
    const handled: Error[] = [];
    const report = damagedEntryReporter(() => onError);
    const damaged = new LedgerEntryDamagedError("log", 1, "why");
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      report(damaged);
      expect(write).toHaveBeenCalledTimes(1);

      onError = (error) => {
        handled.push(error);
      };
      report(damaged);

      expect(handled).toEqual([damaged]);
      expect(write).toHaveBeenCalledTimes(1);
    } finally {
      write.mockRestore();
    }
  });

  it("does not stop a device being removed, and the grants of the readable entries are revoked", async () => {
    const removed = Uint8Array.from(generateIdentity().deviceId);
    const removedHex = deviceIdToHex(removed);
    const { ledger, storage, account, reports } = await ledgerWithGrants([
      removedHex,
      deviceIdToHex(Uint8Array.from(generateIdentity().deviceId)),
      removedHex,
    ]);
    await storage.set(await entryKey(storage, DAMAGED_SEQ), freshId());

    const { entries, unreadable } = await removeDevice({
      userIdentity: await toIdentityPort(account),
      accountLedger: ledger,
      clock: createSystemClock(),
      revocation: createRevocationView(),
      deviceId: removed,
    });

    expect(entries).toHaveLength(2);
    expect(unreadable).toBe(1);
    expect(reports).toHaveLength(1);
    expect(await ledger.outstandingGrants("device", removedHex)).toEqual([]);
  });
});

async function entryKeyOfOne(
  storage: Readonly<ReturnType<typeof createMemoryStorage>>,
): Promise<string> {
  const key = (await storage.keys("data/")).find(
    (candidate) => !candidate.endsWith("/head"),
  );
  if (key === undefined) throw new Error("no entry stored");
  return key;
}

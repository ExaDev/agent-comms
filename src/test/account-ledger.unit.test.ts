/**
 * Unit tests for the account's replicated grant ledger (agent-comms#344): its sealing and writer-log recognition, replication between two machines holding the same account key by plain data-domain frame exchange, revocation from a machine other than the one that minted the grant, and migration of a pre-ledger user-identity.json.
 */

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "wire-mesh-core/adapters/memory-storage";
import { createNodeFsStorage } from "wire-mesh-core/adapters/node-fs-storage";
import { createSystemClock } from "wire-mesh-core/adapters/system-clock";
import { mintRevocationEntry } from "wire-mesh-core/domain/tokens";
import type {
  DataEntriesFrame,
  DataHaveFrame,
  DataRequestFrame,
  RevocationEntry,
} from "wire-mesh-core/generated/protocol";
import type { KeyValueStorage } from "wire-mesh-core/ports/storage";
import {
  deriveAccountLedgerKeys,
  generateWriterNonce,
  isWriterLogId,
  openLedgerEntry,
  sealLedgerEntry,
  writerLogId,
} from "../core/account-ledger-crypto.js";
import { AccountLedger } from "../core/account-ledger.js";
import { openAccountLedger } from "../core/account-ledger-store.js";
import { generateIdentity, type PeerIdentity } from "../core/identity.js";
import {
  createFileLedgerLock,
  createInProcessLedgerLock,
} from "../core/ledger-lock.js";
import { randomId } from "../core/random-id.js";
import {
  loadOrCreateUserIdentity,
  readLegacyIssuedGrants,
} from "../core/user-identity.js";
import { toIdentityPort } from "../core/wire-mesh-identity.js";

type LedgerFrame = DataHaveFrame | DataRequestFrame | DataEntriesFrame;

/** Enough appends in flight at once that two unserialised writers would all but certainly read the same head at least once. */
const CONCURRENT_APPENDS = 8;

/** One machine's copy of an account's ledger: its own storage and writer nonce, the account key it shares with every other machine of the account. */
function machineLedger(account: Readonly<PeerIdentity>): AccountLedger {
  return new AccountLedger({
    accountPrivateKey: account.privateKey,
    writerNonce: generateWriterNonce(),
    storage: createMemoryStorage(),
    lock: createInProcessLedgerLock(),
    clock: createSystemClock(),
  });
}

/** Wraps `inner` so a test can stop a data log's head write half-way, the way a filesystem write that truncates and then writes can be caught between the two by a reader in another process: the head is left empty until the test releases it. */
function pausingHeadWrites(inner: Readonly<KeyValueStorage>): {
  storage: KeyValueStorage;
  pauseNextHeadWrite: () => {
    reached: Promise<undefined>;
    release: () => void;
  };
} {
  let pending: { arrive: () => void; released: Promise<undefined> } | undefined;
  const storage: KeyValueStorage = {
    get: async (key) => inner.get(key),
    delete: async (key) => inner.delete(key),
    keys: async (prefix) => inner.keys(prefix),
    set: async (key, value) => {
      const pause = key.endsWith("/head") ? pending : undefined;
      if (pause !== undefined) {
        pending = undefined;
        await inner.set(key, new Uint8Array());
        pause.arrive();
        await pause.released;
      }
      await inner.set(key, value);
    },
  };
  return {
    storage,
    pauseNextHeadWrite: () => {
      const reached = Promise.withResolvers<undefined>();
      const released = Promise.withResolvers<undefined>();
      pending = {
        arrive: () => {
          reached.resolve(undefined);
        },
        released: released.promise,
      };
      return {
        reached: reached.promise,
        release: () => {
          released.resolve(undefined);
        },
      };
    },
  };
}

/** Runs the data-domain exchange a transport would between two connected machines until `to` holds everything `from` offers: have, then request and entries until caught up. */
async function replicate(
  from: AccountLedger,
  to: AccountLedger,
): Promise<void> {
  for (const have of await from.announcements()) {
    let next: LedgerFrame | null = await to.handleDataFrame(have);
    while (next !== null && next.type === "data-request") {
      const entries = await from.handleDataFrame(next);
      if (entries === null) break;
      await to.handleDataFrame(entries);
      next = await to.handleDataFrame(have);
    }
  }
}

async function tokenIds(
  ledger: AccountLedger,
  kind: "device" | "dm",
  subject: string,
): Promise<Uint8Array[]> {
  const grants = await ledger.outstandingGrants(kind, subject);
  return grants.map((grant) => grant.tokenId);
}

describe("account ledger sealing", () => {
  const account = generateIdentity();
  const keys = deriveAccountLedgerKeys(account.privateKey);
  const log = writerLogId(keys, generateWriterNonce());
  const plaintext = randomId();

  it("opens an entry sealed for the same log and position", () => {
    const sealed = sealLedgerEntry(keys, log, 1, plaintext);
    expect(openLedgerEntry(keys, log, 1, sealed)).toEqual(plaintext);
  });

  it("does not open an entry moved to another position, another log, or under another account", () => {
    const sealed = sealLedgerEntry(keys, log, 1, plaintext);
    const otherLog = writerLogId(keys, generateWriterNonce());
    const otherKeys = deriveAccountLedgerKeys(generateIdentity().privateKey);

    expect(openLedgerEntry(keys, log, 2, sealed)).toBeUndefined();
    expect(openLedgerEntry(keys, otherLog, 1, sealed)).toBeUndefined();
    expect(openLedgerEntry(otherKeys, log, 1, sealed)).toBeUndefined();
  });

  it("recognises its own writer logs and nothing else", () => {
    const otherKeys = deriveAccountLedgerKeys(generateIdentity().privateKey);

    expect(isWriterLogId(keys, log)).toBe(true);
    expect(isWriterLogId(otherKeys, log)).toBe(false);
    expect(isWriterLogId(keys, randomId())).toBe(false);
  });

  it("derives the same keys from every copy of the account key", () => {
    const copy = deriveAccountLedgerKeys(account.privateKey);
    const sealed = sealLedgerEntry(keys, log, 1, plaintext);

    expect(openLedgerEntry(copy, log, 1, sealed)).toEqual(plaintext);
  });
});

describe("account ledger replication", () => {
  it("lets a second machine holding the account key revoke a grant the first minted", async () => {
    const account = generateIdentity();
    const accountPort = await toIdentityPort(account);
    const first = machineLedger(account);
    const second = machineLedger(account);
    const tokenId = randomId();

    await first.recordGrant("device", "device-a", tokenId);
    await replicate(first, second);
    expect(await tokenIds(second, "device", "device-a")).toEqual([tokenId]);

    const revocation = await mintRevocationEntry({
      identity: accountPort,
      tokenId,
      revokedAt: Date.now(),
    });
    await second.recordRevocation("device", "device-a", tokenId, revocation);
    const learned: RevocationEntry[] = [];
    first.onReplicatedRevocation((entry) => {
      learned.push(entry);
    });
    await replicate(second, first);

    expect(await tokenIds(first, "device", "device-a")).toEqual([]);
    expect(learned).toEqual([revocation]);
    expect(await first.revocations()).toEqual([revocation]);
  });

  it("keeps both machines' grants when each appends while apart", async () => {
    const account = generateIdentity();
    const first = machineLedger(account);
    const second = machineLedger(account);
    const fromFirst = randomId();
    const fromSecond = randomId();

    await first.recordGrant("dm", "bearer", fromFirst);
    await second.recordGrant("dm", "bearer", fromSecond);
    await replicate(first, second);
    await replicate(second, first);

    for (const ledger of [first, second]) {
      expect(await tokenIds(ledger, "dm", "bearer")).toEqual(
        expect.arrayContaining([fromFirst, fromSecond]),
      );
      expect(await tokenIds(ledger, "dm", "bearer")).toHaveLength(2);
    }
  });

  it("refuses entries for one of its writer logs that were not sealed under the account key", async () => {
    const account = generateIdentity();
    const ledger = machineLedger(account);
    const keys = deriveAccountLedgerKeys(account.privateKey);
    const log = writerLogId(keys, generateWriterNonce());
    const forged = sealLedgerEntry(
      deriveAccountLedgerKeys(generateIdentity().privateKey),
      log,
      1,
      Uint8Array.from([0]),
    );

    await ledger.handleDataFrame({
      type: "data-entries",
      peer: log,
      "from-seq": 0,
      entries: [forged],
    });

    expect(ledger.ownsLog(log)).toBe(true);
    expect(await ledger.announcements()).toEqual([]);
  });

  it("gives no reading to a machine without the account key", async () => {
    const account = generateIdentity();
    const ledger = machineLedger(account);
    const stranger = machineLedger(generateIdentity());

    await ledger.recordGrant("device", "device-a", randomId());
    const [have] = await ledger.announcements();
    if (have === undefined) throw new Error("expected an announcement");

    expect(stranger.ownsLog(have.peer)).toBe(false);
  });

  it("never misses a replicated grant while another bridge on the machine is storing that log", async () => {
    const account = generateIdentity();
    const origin = machineLedger(account);
    const dir = fs.mkdtempSync(path.join(tmpdir(), "agent-comms-ledger-fs-"));
    const tornWrite = pausingHeadWrites(createNodeFsStorage({ dir }));
    const machineLock = `${dir}.lock`;
    const replicator = new AccountLedger({
      accountPrivateKey: account.privateKey,
      writerNonce: generateWriterNonce(),
      storage: tornWrite.storage,
      lock: createFileLedgerLock(machineLock),
      clock: createSystemClock(),
    });
    const readerQueued = Promise.withResolvers<undefined>();
    const readerLock = createFileLedgerLock(machineLock);
    const reader = new AccountLedger({
      accountPrivateKey: account.privateKey,
      writerNonce: generateWriterNonce(),
      storage: tornWrite.storage,
      lock: {
        run: async (critical) => {
          readerQueued.resolve(undefined);
          return readerLock.run(critical);
        },
      },
      clock: createSystemClock(),
    });
    await origin.recordGrant("dm", "bearer", randomId());
    await replicate(origin, replicator);
    await origin.recordGrant("dm", "bearer", randomId());

    const paused = tornWrite.pauseNextHeadWrite();
    const replicating = replicate(origin, replicator);
    await paused.reached;
    const reading = reader.outstandingGrants("dm", "bearer");
    // The read either finishes while the head is torn, or is queued behind the write; only then does the write complete.
    await Promise.race([reading, readerQueued.promise]);
    paused.release();
    await replicating;

    expect(await reading).toHaveLength(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not fork its writer log when several stores on one machine append at once", async () => {
    const account = generateIdentity();
    const shared = {
      accountPrivateKey: account.privateKey,
      writerNonce: generateWriterNonce(),
      storage: createMemoryStorage(),
      lock: createInProcessLedgerLock(),
      clock: createSystemClock(),
    };
    const stores = [new AccountLedger(shared), new AccountLedger(shared)];
    const issued = Array.from({ length: CONCURRENT_APPENDS }, () => randomId());

    await Promise.all(
      issued.map(async (tokenId, index) =>
        stores[index % stores.length]?.recordGrant("dm", "bearer", tokenId),
      ),
    );

    const [first] = stores;
    if (first === undefined) throw new Error("expected a store");
    expect(await tokenIds(first, "dm", "bearer")).toEqual(
      expect.arrayContaining(issued),
    );
    expect(await tokenIds(first, "dm", "bearer")).toHaveLength(issued.length);
  });
});

describe("openAccountLedger", () => {
  function userDir(): string {
    return fs.mkdtempSync(path.join(tmpdir(), "agent-comms-account-ledger-"));
  }

  function writeLegacyGrants(dir: string): void {
    const file = path.join(dir, "user-identity.json");
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("user-identity.json is not an object");
    }
    fs.writeFileSync(
      file,
      JSON.stringify({
        ...parsed,
        issuedDeviceGrants: {
          "device-a": Buffer.from([1, 1]).toString("base64"),
        },
        issuedDmGrants: { "bearer-a": Buffer.from([2, 2]).toString("base64") },
      }),
    );
  }

  it("migrates an existing user-identity.json's issued grants into the ledger and removes them from the file", async () => {
    const dir = userDir();
    const userIdentity = loadOrCreateUserIdentity({ dir });
    writeLegacyGrants(dir);

    const ledger = await openAccountLedger({
      userIdentityOptions: { dir },
      userIdentity,
      clock: createSystemClock(),
    });

    expect(await tokenIds(ledger, "device", "device-a")).toEqual([
      Uint8Array.from([1, 1]),
    ]);
    expect(await tokenIds(ledger, "dm", "bearer-a")).toEqual([
      Uint8Array.from([2, 2]),
    ]);
    expect(readLegacyIssuedGrants({ dir })).toEqual([]);
  });

  it("keeps migrated grants across a restart without recording them twice", async () => {
    const dir = userDir();
    const userIdentity = loadOrCreateUserIdentity({ dir });
    writeLegacyGrants(dir);
    const options = {
      userIdentityOptions: { dir },
      userIdentity,
      clock: createSystemClock(),
    };

    await openAccountLedger(options);
    const reopened = await openAccountLedger(options);

    expect(await tokenIds(reopened, "device", "device-a")).toEqual([
      Uint8Array.from([1, 1]),
    ]);
    const [have] = await reopened.announcements();
    expect(have?.["head-seq"]).toBe(2);
  });

  it("replicates a migrated grant to another machine, which can then revoke it", async () => {
    const dir = userDir();
    const userIdentity = loadOrCreateUserIdentity({ dir });
    writeLegacyGrants(dir);
    const migrated = await openAccountLedger({
      userIdentityOptions: { dir },
      userIdentity,
      clock: createSystemClock(),
    });
    const other = machineLedger(userIdentity);

    await replicate(migrated, other);
    const [grant] = await other.outstandingGrants("device", "device-a");
    if (grant === undefined) throw new Error("expected the migrated grant");
    const revocation = await mintRevocationEntry({
      identity: await toIdentityPort(userIdentity),
      tokenId: grant.tokenId,
      revokedAt: Date.now(),
    });
    await other.recordRevocation(
      "device",
      "device-a",
      grant.tokenId,
      revocation,
    );
    await replicate(other, migrated);

    expect(await tokenIds(migrated, "device", "device-a")).toEqual([]);
  });
});

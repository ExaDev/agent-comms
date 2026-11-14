/**
 * An unreadable account ledger entry can hold a revocation as well as a grant, so every operation that reads the ledger says when it skipped one: the result carries the count, start-up reports that revocations may be missing, and whoami lists it.
 */

import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "wire-mesh-core/adapters/memory-storage";
import { createSystemClock } from "wire-mesh-core/adapters/system-clock";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { createRevocationView } from "wire-mesh-core/domain/revocation-view";
import { generateWriterNonce } from "../core/account-ledger-crypto.js";
import {
  AccountLedger,
  followLedgerRevocations,
  type LedgerEntryDamagedError,
} from "../core/account-ledger.js";
import { removeDevice } from "../core/device-membership.js";
import { dmRevoke } from "../core/dm-grant-actions.js";
import { generateIdentity } from "../core/identity.js";
import { createInProcessLedgerLock } from "../core/ledger-lock.js";
import { randomId } from "../core/random-id.js";
import { toIdentityPort } from "../core/wire-mesh-identity.js";

/** The position of the revocation entry in the ledger these tests build: one grant, then its revocation. */
const REVOKE_SEQ = 2;
/** Time for the revocations followLedgerRevocations learns asynchronously to be reported. */
const SETTLE_MS = 50;

async function ledgerWithRevokedGrant() {
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
  const device = Uint8Array.from(generateIdentity().deviceId);
  const deviceHex = deviceIdToHex(device);
  await ledger.recordGrant("device", deviceHex, Uint8Array.from(randomId()));
  const user = await toIdentityPort(account);
  const revocation = createRevocationView();
  const removed = await removeDevice({
    userIdentity: user,
    accountLedger: ledger,
    clock: createSystemClock(),
    revocation,
    deviceId: device,
  });
  const keys = (await storage.keys("data/")).filter(
    (key) => !key.endsWith("/head"),
  );
  keys.sort();
  return {
    account,
    storage,
    ledger,
    reports,
    device,
    deviceHex,
    user,
    keys,
    removed,
  };
}

async function damageRevocation(
  fixture: Awaited<ReturnType<typeof ledgerWithRevokedGrant>>,
): Promise<void> {
  const key = fixture.keys[REVOKE_SEQ - 1];
  if (key === undefined) throw new Error("no revocation entry stored");
  await fixture.storage.set(key, Uint8Array.from(randomId()));
}

describe("a damaged revocation entry", () => {
  it("is counted by the read that skips it, and makes the grant it revoked outstanding again", async () => {
    const fixture = await ledgerWithRevokedGrant();
    expect(fixture.removed.entries).toHaveLength(1);
    expect(
      await fixture.ledger.outstandingGrantsChecked(
        "device",
        fixture.deviceHex,
      ),
    ).toEqual({ grants: [], unreadable: 0 });

    await damageRevocation(fixture);
    const checked = await fixture.ledger.outstandingGrantsChecked(
      "device",
      fixture.deviceHex,
    );

    expect(checked.unreadable).toBe(1);
    expect(checked.grants).toHaveLength(1);
    expect((await fixture.ledger.revocations()).unreadable).toBe(1);
    expect((await fixture.ledger.revocations()).entries).toEqual([]);
  });

  it("is reported at start-up as revocations that may be missing, through the error channel", async () => {
    const fixture = await ledgerWithRevokedGrant();
    await damageRevocation(fixture);
    const errors: Error[] = [];

    const stop = followLedgerRevocations(
      {
        accountLedger: fixture.ledger,
        revocation: createRevocationView(),
        identity: fixture.user,
      },
      (error) => {
        errors.push(error);
      },
    );
    await new Promise<void>((resolve) => {
      setTimeout(resolve, SETTLE_MS);
    });
    stop();

    expect(
      errors.some((error) =>
        error.message.includes("revocation recorded only in them"),
      ),
    ).toBe(true);
  });

  it("makes removeDevice report the removal as incomplete", async () => {
    const fixture = await ledgerWithRevokedGrant();
    await damageRevocation(fixture);

    const result = await removeDevice({
      userIdentity: fixture.user,
      accountLedger: fixture.ledger,
      clock: createSystemClock(),
      revocation: createRevocationView(),
      deviceId: fixture.device,
    });

    expect(result.unreadable).toBe(1);
    expect(result.entries).toHaveLength(1);
  });

  it("is listed for whoami, once, however often it is met", async () => {
    const fixture = await ledgerWithRevokedGrant();
    await damageRevocation(fixture);

    await fixture.ledger.revocations();
    await fixture.ledger.revocations();

    expect(fixture.ledger.unreadableEntries()).toHaveLength(1);
    expect(fixture.reports).toHaveLength(1);
    expect(fixture.reports[0]?.message).toContain("a grant or a revocation");
  });
});

describe("dm_revoke over a ledger with an unreadable entry", () => {
  it("is an error that says grants may remain valid, not a clean success", async () => {
    const result = await dmRevoke(
      { revokeAgentDmAccess: async () => Promise.resolve({ unreadable: 2 }) },
      { action: "dm_revoke", target: "someone" },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("2 ledger entries cannot be read");
    expect(result.content).toContain("still valid");
  });
});

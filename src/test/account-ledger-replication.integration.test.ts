/**
 * Integration tests for the account's replicated grant ledger over a real mesh (agent-comms#344): two machines holding the same account key, each with its own user-identity.json and ledger store, connected directly. A grant minted on one reaches the other by data-domain fan-out, and the other can then revoke it, which a machine-local ledger could never do.
 */

import { afterEach, describe, expect, it } from "vitest";
import { generateIdentity } from "../core/identity.js";
import { loadOrCreateUserIdentity } from "../core/user-identity.js";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { freeLocalPort, TeardownStack } from "./hub-helpers.js";
import { waitFor } from "./test-transport.js";
import {
  copyAccountKey,
  ledgerOn,
  outstandingDm,
  removeUserDirs,
  startMachine,
  userDir,
} from "./account-ledger-helpers.js";

const cleanups = new TeardownStack();

afterEach(async () => {
  await cleanups.run();
  removeUserDirs();
});

async function machine(
  coordinatorPort: number,
  userIdentityDir: string,
  name: string,
): ReturnType<typeof startMachine> {
  return startMachine(cleanups, { coordinatorPort, userIdentityDir, name });
}

describe("account ledger replication", () => {
  it("revokes on a second machine a DM grant minted on the first", async () => {
    const port = await freeLocalPort();
    const dirA = userDir();
    const dirB = userDir();
    loadOrCreateUserIdentity({ dir: dirA });
    copyAccountKey(dirA, dirB);

    const { store: a } = await machine(port, dirA, "machine-a");
    const { store: b } = await machine(port, dirB, "machine-b");
    expect(b.getUserPrincipalId()).toBe(a.getUserPrincipalId());
    const bearer = deviceIdToHex(Uint8Array.from(generateIdentity().deviceId));

    await a.admitAgentForDm(bearer);
    const ledgerA = await ledgerOn(dirA);
    const ledgerB = await ledgerOn(dirB);
    const [minted] = await outstandingDm(ledgerA, bearer);
    if (minted === undefined) throw new Error("expected A to record its grant");

    await waitFor(
      async () => (await outstandingDm(ledgerB, bearer)).includes(minted),
      "B's ledger to hold the grant A minted",
    );
    await b.revokeAgentDmAccess(bearer);

    expect(await outstandingDm(ledgerB, bearer)).toEqual([]);
    await waitFor(
      async () => (await outstandingDm(ledgerA, bearer)).length === 0,
      "A's ledger to learn B's revocation",
    );
    expect(await ledgerA.revocations()).toHaveLength(1);
  });

  it("teaches a machine a revocation made on another through the replicated ledger alone", async () => {
    const port = await freeLocalPort();
    const dirA = userDir();
    const dirB = userDir();
    loadOrCreateUserIdentity({ dir: dirA });
    copyAccountKey(dirA, dirB);
    const a = await machine(port, dirA, "machine-a");
    const b = await machine(port, dirB, "machine-b");
    const bearer = deviceIdToHex(Uint8Array.from(generateIdentity().deviceId));
    // The gossiped revocation-announce never leaves B, so the only way A can learn of the revocation is B's writer log.
    b.transport.broadcastRevocation = async () => {};

    await a.store.admitAgentForDm(bearer);
    const ledgerB = await ledgerOn(dirB);
    await waitFor(
      async () => (await outstandingDm(ledgerB, bearer)).length === 1,
      "B's ledger to hold the grant A minted",
    );
    const [minted] = await ledgerB.outstandingGrants("dm", bearer);
    if (minted === undefined) throw new Error("expected the minted grant");
    await b.store.revokeAgentDmAccess(bearer);

    await waitFor(
      async () => (await a.revocation.entriesFor(minted.tokenId)).length > 0,
      "A's RevocationView to refuse the grant B revoked",
    );
  });

  it("never offers the ledger to a device of another account", async () => {
    const port = await freeLocalPort();
    const dirA = userDir();
    const dirB = userDir();
    const dirOther = userDir();
    loadOrCreateUserIdentity({ dir: dirA });
    copyAccountKey(dirA, dirB);
    const a = await machine(port, dirA, "machine-a");
    const b = await machine(port, dirB, "machine-b");
    const other = await machine(port, dirOther, "other-account");
    const bearer = deviceIdToHex(Uint8Array.from(generateIdentity().deviceId));

    await a.store.admitAgentForDm(bearer);
    const ledgerB = await ledgerOn(dirB);
    await waitFor(
      async () => (await outstandingDm(ledgerB, bearer)).length === 1,
      "B's ledger to hold the grant A minted",
    );
    const [writerLog] = await (await ledgerOn(dirA)).announcements();
    if (writerLog === undefined) throw new Error("expected A's writer log");

    // Every announcement round that reached B also passed the other account's device, so by now it would have asked for and stored the log if it had been offered.
    expect(
      await other.dataStorage.keys(`data/${deviceIdToHex(writerLog.peer)}/`),
    ).toEqual([]);
  });
});

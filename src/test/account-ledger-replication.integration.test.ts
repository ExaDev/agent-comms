/**
 * Integration tests for the account's replicated grant ledger over a real mesh (agent-comms#344): two machines holding the same account key, each with its own user-identity.json and ledger store, connected directly. A grant minted on one reaches the other by data-domain fan-out, and the other can then revoke it, which a machine-local ledger could never do.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryStorage } from "wire-mesh-core/adapters/memory-storage";
import { createSystemClock } from "wire-mesh-core/adapters/system-clock";
import type { KeyValueStorage } from "wire-mesh-core/ports/storage";
import {
  createRevocationView,
  type RevocationView,
} from "wire-mesh-core/domain/revocation-view";
import { MeshStore } from "../core/mesh-store.js";
import type { WireMeshTransport } from "../core/wire-mesh-transport.js";
import { openAccountLedger } from "../core/account-ledger-store.js";
import type { AccountLedger } from "../core/account-ledger.js";
import { generateIdentity } from "../core/identity.js";
import { loadOrCreateUserIdentity } from "../core/user-identity.js";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { freeLocalPort, TeardownStack } from "./hub-helpers.js";
import { waitFor, wireTestTransportWithHub } from "./test-transport.js";

/** Short enough that the ledger's announcement round, which rides the re-advertise cadence, fires many times within a test's wait budget. */
const FAST_GOSSIP_INTERVAL_MS = 50;

const cleanups = new TeardownStack();
const dirs: string[] = [];

afterEach(async () => {
  await cleanups.run();
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function userDir(): string {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "ledger-replication-user-"));
  dirs.push(dir);
  return dir;
}

/** Gives `toDir` a copy of the account key in `fromDir` and nothing else, as a deliberate copy of the key to a second machine would. */
function copyAccountKey(fromDir: string, toDir: string): void {
  const parsed: unknown = JSON.parse(
    fs.readFileSync(path.join(fromDir, "user-identity.json"), "utf-8"),
  );
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("privateKey" in parsed) ||
    !("certificate" in parsed) ||
    !("expiresAt" in parsed)
  ) {
    throw new Error("user-identity.json has no key material");
  }
  const { privateKey, certificate, expiresAt } = parsed;
  fs.writeFileSync(
    path.join(toDir, "user-identity.json"),
    JSON.stringify({ privateKey, certificate, expiresAt }),
    { mode: 0o600 },
  );
}

interface Machine {
  store: MeshStore;
  transport: WireMeshTransport;
  revocation: RevocationView;
  /** Where anything another device offers this one outside its own account ledger is stored. */
  dataStorage: KeyValueStorage;
}

async function machine(
  coordinatorPort: number,
  userIdentityDir: string,
  name: string,
): Promise<Machine> {
  const store = new MeshStore({ coordinatorPort });
  const revocation = createRevocationView();
  const dataStorage = createMemoryStorage();
  const { transport } = await wireTestTransportWithHub(store, {
    presenceReadvertiseIntervalMs: FAST_GOSSIP_INTERVAL_MS,
    userIdentityOptions: { dir: userIdentityDir },
    revocation,
    dataStorage,
  });
  await store.init();
  cleanups.push(async () => store.shutdown());
  // A visible agent's advert carries its device's membership proof, which is how the other machine recognises it as holding the same account and offers it the ledger.
  await store.registerAgent({
    name,
    harness: "test",
    cwd: `/test/${name}`,
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  return { store, transport, revocation, dataStorage };
}

/** Another handle on a machine's ledger store, the way a second bridge on that machine would open it. */
async function ledgerOn(dir: string): Promise<AccountLedger> {
  return openAccountLedger({
    userIdentityOptions: { dir },
    userIdentity: loadOrCreateUserIdentity({ dir }),
    clock: createSystemClock(),
  });
}

async function outstandingDm(
  ledger: AccountLedger,
  bearer: string,
): Promise<string[]> {
  const grants = await ledger.outstandingGrants("dm", bearer);
  return grants.map((grant) => Buffer.from(grant.tokenId).toString("hex"));
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

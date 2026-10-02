/**
 * Shared fixtures for the account ledger's replication integration tests (agent-comms#344): machines that hold one account key, each with its own user-identity.json and ledger store.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
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
import { loadOrCreateUserIdentity } from "../core/user-identity.js";
import type { TeardownStack } from "./hub-helpers.js";
import { wireTestTransportWithHub } from "./test-transport.js";

/** Short enough that the ledger's announcement round, which rides the re-advertise cadence, fires many times within a test's wait budget. */
export const FAST_GOSSIP_INTERVAL_MS = 50;

const dirs: string[] = [];

/** A fresh throwaway directory for one machine's user-identity.json, removed by removeUserDirs. */
export function userDir(): string {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "ledger-replication-user-"));
  dirs.push(dir);
  return dir;
}

export function removeUserDirs(): void {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Gives `toDir` a copy of the account key in `fromDir` and nothing else, as a deliberate copy of the key to a second machine would. */
export function copyAccountKey(fromDir: string, toDir: string): void {
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

export interface Machine {
  store: MeshStore;
  transport: WireMeshTransport;
  revocation: RevocationView;
  /** Where anything another device offers this one outside its own account ledger is stored. */
  dataStorage: KeyValueStorage;
}

/** Starts one machine on the local mesh at `coordinatorPort`, holding the account key in `userIdentityDir`, dialling `hubUrl` when given, and registers a visible agent so its adverts carry the membership proof by which another machine recognises it as holding the same account. */
export async function startMachine(
  cleanups: TeardownStack,
  options: Readonly<{
    coordinatorPort: number;
    userIdentityDir: string;
    name: string;
    hubUrl?: string;
  }>,
): Promise<Machine> {
  const { coordinatorPort, userIdentityDir, name, hubUrl } = options;
  const store = new MeshStore({
    coordinatorPort,
    ...(hubUrl === undefined ? {} : { hubUrl }),
  });
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
export async function ledgerOn(dir: string): Promise<AccountLedger> {
  return openAccountLedger({
    userIdentityOptions: { dir },
    userIdentity: loadOrCreateUserIdentity({ dir }),
    clock: createSystemClock(),
  });
}

/** The token ids (hex) of the dm grants the ledger holds outstanding for `bearer`. */
export async function outstandingDm(
  ledger: AccountLedger,
  bearer: string,
): Promise<string[]> {
  const grants = await ledger.outstandingGrants("dm", bearer);
  return grants.map((grant) => Buffer.from(grant.tokenId).toString("hex"));
}

/**
 * An account machine whose ledger replication is held back on every path notices that it is behind, says so once, and recovers when a second path supplies the entries: the revocation in them then takes effect and the stall clears from what whoami reports. Three machines hold one account on a real local mesh (agent-comms#344).
 */

import { afterEach, expect, it } from "vitest";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import type { Connection } from "wire-mesh-core/ports/transport";
import type { Frame } from "wire-mesh-core/generated/protocol";
import { buildAction } from "../core/bridge.js";
import { generateIdentity } from "../core/identity.js";
import { CommsTool } from "../core/tool.js";
import { loadOrCreateUserIdentity } from "../core/user-identity.js";
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

/** Long enough for several replication rounds to pass with nothing arriving. */
const QUIET_PERIOD_MS = 600;

const cleanups = new TeardownStack();

afterEach(async () => {
  await cleanups.run();
  removeUserDirs();
});

it("reports a log held back on every path once, and recovers when a second path supplies the entries", async () => {
  const port = await freeLocalPort();
  const dirA = userDir();
  const dirB = userDir();
  const dirC = userDir();
  loadOrCreateUserIdentity({ dir: dirA });
  copyAccountKey(dirA, dirB);
  copyAccountKey(dirA, dirC);
  const a = await startMachine(cleanups, {
    coordinatorPort: port,
    userIdentityDir: dirA,
    name: "machine-a",
  });
  const b = await startMachine(cleanups, {
    coordinatorPort: port,
    userIdentityDir: dirB,
    name: "machine-b",
  });
  const c = await startMachine(cleanups, {
    coordinatorPort: port,
    userIdentityDir: dirC,
    name: "machine-c",
  });
  // The gossiped revocation-announce never leaves A, so the replicated ledger is the only way a revocation reaches B.
  a.transport.broadcastRevocation = async () => {};
  const bearer = deviceIdToHex(Uint8Array.from(generateIdentity().deviceId));
  const errors: Error[] = [];
  const previousOnError = b.store.onError;
  b.store.onError = (error) => {
    errors.push(error);
    previousOnError?.(error);
  };

  await a.store.admitAgentForDm(bearer);
  const ledgerB = await ledgerOn(dirB);
  await waitFor(
    async () => (await outstandingDm(ledgerB, bearer)).length === 1,
    "B's ledger to hold the grant A minted",
  );
  const [minted] = await ledgerB.outstandingGrants("dm", bearer);
  if (minted === undefined) throw new Error("expected the minted grant");
  await waitFor(
    async () =>
      (
        await ledgerOn(dirC).then(async (ledger) =>
          outstandingDm(ledger, bearer),
        )
      ).length === 1,
    "C's ledger to hold the grant A minted",
  );

  // From here B accepts no entries from anyone except where `open` allows, which is how a path that drops or withholds them looks to B.
  const open = new Set<string>();
  const route = b.transport.dataFrames.route.bind(b.transport.dataFrames);
  b.transport.dataFrames.route = async (
    connection: Readonly<Connection>,
    frame: Frame,
  ) => {
    const from =
      connection.peerDeviceId === undefined
        ? ""
        : deviceIdToHex(Uint8Array.from(connection.peerDeviceId));
    if (frame.type === "data-entries" && !open.has(from)) return;
    await route(connection, frame);
  };
  const cDevice = c.store.peerId;

  await a.store.revokeAgentDmAccess(bearer);
  await waitFor(
    async () => b.transport.dataFrames.stalledLogs().length === 1,
    "B to notice its log of A's is behind",
  );
  const stalledErrors = (): Error[] =>
    errors.filter((error) => error.message.includes("stayed behind"));
  await waitFor(
    async () => stalledErrors().length === 1,
    "the stall to be reported",
  );
  // More rounds pass with nothing arriving: the same gap is not reported again, and the grant is still outstanding on B.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, QUIET_PERIOD_MS);
  });
  expect(stalledErrors()).toHaveLength(1);
  expect(await outstandingDm(ledgerB, bearer)).toEqual(
    [minted.tokenId].map((id) => Buffer.from(id).toString("hex")),
  );
  const tool = new CommsTool(b.store, {
    getStalledLedgerLogs: () => b.transport.dataFrames.stalledLogs(),
  });
  const ctx = {
    agentId: b.agentId,
    harness: "test",
    cwd: "/test/machine-b",
    pid: process.pid,
  };
  expect(
    (await tool.handle(ctx, buildAction({ action: "whoami" }))).content,
  ).toContain("Account ledger log ");

  // A second path: entries from C reach B.
  open.add(cDevice);

  await waitFor(
    async () => (await b.revocation.entriesFor(minted.tokenId)).length > 0,
    "the revocation in the missing entries to take effect on B",
  );
  await waitFor(
    async () => b.transport.dataFrames.stalledLogs().length === 0,
    "the stall to clear",
  );
  expect(
    (await tool.handle(ctx, buildAction({ action: "whoami" }))).content,
  ).not.toContain("Account ledger log ");
  expect(stalledErrors()).toHaveLength(1);
});

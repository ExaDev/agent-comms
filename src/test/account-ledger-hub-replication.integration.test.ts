/**
 * Integration test for the account's replicated grant ledger between machines that meet only through the relay hub (agent-comms#358): two machines holding the same account key, on separate local meshes with no direct connection, sharing a real relay hub (createRelayHub served over local WebSockets). A grant minted on one reaches the other through a relay pairing sealed end to end, and the other can then revoke it.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createMemoryStorage } from "wire-mesh-core/adapters/memory-storage";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { generateIdentity } from "../core/identity.js";
import { loadOrCreateUserIdentity } from "../core/user-identity.js";
import { freeLocalPort, realHubOverWs, TeardownStack } from "./hub-helpers.js";
import { waitFor } from "./test-transport.js";
import {
  FAST_GOSSIP_INTERVAL_MS,
  copyAccountKey,
  ledgerOn,
  outstandingDm,
  removeUserDirs,
  startMachine,
  userDir,
} from "./account-ledger-helpers.js";

/** How many announcement rounds a test lets pass before concluding that a log was never offered. */
const ANNOUNCEMENT_ROUNDS_TO_WAIT = 20;

const cleanups = new TeardownStack();

afterEach(async () => {
  await cleanups.run();
  removeUserDirs();
});

describe("account ledger replication through the relay hub", () => {
  it("revokes on a machine met only through the hub a DM grant minted on the other", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);
    const dirA = userDir();
    const dirB = userDir();
    loadOrCreateUserIdentity({ dir: dirA });
    copyAccountKey(dirA, dirB);

    const a = await startMachine(cleanups, {
      coordinatorPort: await freeLocalPort(),
      userIdentityDir: dirA,
      name: "machine-a",
      hubUrl: hub.url,
    });
    const b = await startMachine(cleanups, {
      coordinatorPort: await freeLocalPort(),
      userIdentityDir: dirB,
      name: "machine-b",
      hubUrl: hub.url,
    });
    const principal = a.store.getUserPrincipalId();
    if (principal === undefined) throw new Error("expected an account");
    expect(b.store.getUserPrincipalId()).toBe(principal);
    // Each machine trusts the account's principal, which is what lets the hub admit the other's devices.
    a.store.addTrustedGatewayPrincipal(principal);
    b.store.addTrustedGatewayPrincipal(principal);
    // Nothing connects them directly: anything one learns of the other came through the hub.
    expect(a.store.coordinatorPort).not.toBe(b.store.coordinatorPort);

    const bearer = deviceIdToHex(Uint8Array.from(generateIdentity().deviceId));
    await a.store.admitAgentForDm(bearer);
    const ledgerA = await ledgerOn(dirA);
    const ledgerB = await ledgerOn(dirB);
    const [minted] = await outstandingDm(ledgerA, bearer);
    if (minted === undefined) throw new Error("expected A to record its grant");

    await waitFor(
      async () => (await outstandingDm(ledgerB, bearer)).includes(minted),
      "B's ledger to hold the grant A minted, through the hub",
    );
    // The gossiped revocation-announce never leaves B, so A can only learn of the revocation from B's writer log, over the same pairing.
    b.transport.broadcastRevocation = async () => {};
    await b.store.revokeAgentDmAccess(bearer);

    expect(await outstandingDm(ledgerB, bearer)).toEqual([]);
    await waitFor(
      async () => (await outstandingDm(ledgerA, bearer)).length === 0,
      "A's ledger to learn B's revocation, through the hub",
    );
    expect(await ledgerA.revocations()).toHaveLength(1);
  });

  it("never offers the ledger to a device of another account that is on the same hub", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);
    const dirA = userDir();
    const dirOther = userDir();
    loadOrCreateUserIdentity({ dir: dirA });
    const a = await startMachine(cleanups, {
      coordinatorPort: await freeLocalPort(),
      userIdentityDir: dirA,
      name: "machine-a",
      hubUrl: hub.url,
    });
    const other = await startMachine(cleanups, {
      coordinatorPort: await freeLocalPort(),
      userIdentityDir: dirOther,
      name: "other-account",
      hubUrl: hub.url,
    });
    const otherPrincipal = other.store.getUserPrincipalId();
    const principal = a.store.getUserPrincipalId();
    if (otherPrincipal === undefined || principal === undefined) {
      throw new Error("expected both machines to hold an account");
    }
    // Both sides trust each other as devices, so the other account is reachable through the hub and the only thing keeping the ledger from it is that it is not an account peer.
    a.store.addTrustedGatewayPrincipal(otherPrincipal);
    other.store.addTrustedGatewayPrincipal(principal);
    await waitFor(
      async () =>
        (await a.store.listAgents(a.store.peerId)).some(
          (agent) => agent.id === other.store.peerId,
        ),
      "A to see the other account's device through the hub",
    );

    await a.store.admitAgentForDm(
      deviceIdToHex(Uint8Array.from(generateIdentity().deviceId)),
    );
    const [writerLog] = await (await ledgerOn(dirA)).announcements();
    if (writerLog === undefined) throw new Error("expected A's writer log");
    // Many announcement rounds pass in this time, so a device that was offered the log would have asked for and stored it by now.
    await new Promise((resolve) => {
      setTimeout(
        resolve,
        ANNOUNCEMENT_ROUNDS_TO_WAIT * FAST_GOSSIP_INTERVAL_MS,
      );
    });
    expect(
      await other.dataStorage.keys(`data/${deviceIdToHex(writerLog.peer)}/`),
    ).toEqual([]);
  });
});

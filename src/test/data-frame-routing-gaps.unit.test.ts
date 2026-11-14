/**
 * The router records the head every account peer announces, on a direct connection and through the relay hub, before the ledger answers, and only for an account peer's frame for one of the account's logs.
 */

import { describe, expect, it, vi } from "vitest";
import type { Connection } from "wire-mesh-core/ports/transport";
import type { DataHaveFrame } from "wire-mesh-core/generated/protocol";
import type { AccountLedgerReplica } from "../core/account-ledger.js";
import type { LedgerGapTracker } from "../core/ledger-gaps.js";
import {
  DataFrameRouter,
  routeDataFrame,
  routeRelayedDataFrame,
  type AccountReplication,
  type HubDataChannel,
} from "../core/data-frame-routing.js";

const LOG = Uint8Array.from(Buffer.from("05060708", "hex"));
/** A device-id is 32 bytes. */
const DEVICE_ID_BYTES = 32;
const SENDER_BYTES = Uint8Array.from({ length: DEVICE_ID_BYTES }, (_, i) => i);
const SENDER_HEX = Buffer.from(SENDER_BYTES).toString("hex");
const HEAD = 7;

function have(): DataHaveFrame {
  return { type: "data-have", peer: LOG, "head-seq": HEAD };
}

function account(options: Readonly<{ owns: boolean; peer: boolean }>) {
  const ledger: AccountLedgerReplica = {
    ownsLog: () => options.owns,
    handleDataFrame: async () => null,
    announcements: async () => [],
  };
  const value: AccountReplication = {
    ledger: () => ledger,
    isAccountPeer: async () => options.peer,
  };
  return value;
}

describe("a direct data-have", () => {
  const connection = {
    peerDeviceId: SENDER_BYTES,
    send: async () => undefined,
  } as unknown as Connection;
  const base = (
    gaps: Readonly<Pick<LedgerGapTracker, "noteHave">>,
    acct: Readonly<AccountReplication>,
  ) => ({
    connectionsByPeer: new Map<string, Connection>(),
    dataStorage: undefined,
    account: acct,
    peerSessions: new Map([[SENDER_HEX, true]]),
    gaps,
    onError: undefined,
  });

  it("is recorded with its sender and head", async () => {
    const gaps = { noteHave: vi.fn() };

    await routeDataFrame(
      base(gaps, account({ owns: true, peer: true })),
      connection,
      have(),
    );

    expect(gaps.noteHave).toHaveBeenCalledWith(SENDER_HEX, LOG, HEAD);
  });

  it.each([
    ["a device of another account", { owns: true, peer: false }],
    [
      "a frame for a log that is not the account's",
      { owns: false, peer: true },
    ],
  ])("is not recorded for %s", async (_name, options) => {
    const gaps = { noteHave: vi.fn() };

    await routeDataFrame(base(gaps, account(options)), connection, have());

    expect(gaps.noteHave).not.toHaveBeenCalled();
  });

  it("is not recorded for a data-request, which carries no head", async () => {
    const gaps = { noteHave: vi.fn() };

    await routeDataFrame(
      base(gaps, account({ owns: true, peer: true })),
      connection,
      { type: "data-request", peer: LOG, "from-seq": 0 },
    );

    expect(gaps.noteHave).not.toHaveBeenCalled();
  });
});

describe("a data-have relayed through the hub", () => {
  const hub: HubDataChannel = { peers: () => [], send: async () => undefined };

  it("is recorded for an account peer", async () => {
    const gaps = { noteHave: vi.fn() };

    await routeRelayedDataFrame(
      {
        account: account({ owns: true, peer: true }),
        hub,
        gaps,
        onError: undefined,
      },
      "relayed-peer",
      have(),
    );

    expect(gaps.noteHave).toHaveBeenCalledWith("relayed-peer", LOG, HEAD);
  });

  it("is not recorded for a device of another account", async () => {
    const gaps = { noteHave: vi.fn() };

    await routeRelayedDataFrame(
      {
        account: account({ owns: true, peer: false }),
        hub,
        gaps,
        onError: undefined,
      },
      "stranger",
      have(),
    );

    expect(gaps.noteHave).not.toHaveBeenCalled();
  });
});

describe("the router's replication rounds", () => {
  const ROUND_MS = 15;
  const ROUNDS_TO_WAIT = 8;

  it("reports a log that stays behind and asks the peer that announced it for the entries, over its direct connection", async () => {
    const sent: unknown[] = [];
    const connection = {
      peerDeviceId: SENDER_BYTES,
      send: async (frame: unknown) => {
        sent.push(frame);
      },
    } as unknown as Connection;
    const errors: Error[] = [];
    const ledger: AccountLedgerReplica = {
      ownsLog: () => true,
      // This side holds nothing of the log, so every announcement is empty.
      handleDataFrame: async () => null,
      announcements: async () => [],
    };
    const router = new DataFrameRouter({
      dataStorage: undefined,
      account: { ledger: () => ledger, isAccountPeer: async () => true },
      peerSessions: new Map([[SENDER_HEX, true]]),
      onError: (error) => {
        errors.push(error);
      },
      hub: undefined,
      announceIntervalMs: ROUND_MS,
    });
    try {
      await router.route(connection, have());
      await new Promise<void>((resolve) => {
        setTimeout(resolve, ROUND_MS * ROUNDS_TO_WAIT);
      });

      expect(errors.map((e) => e.message).join("\n")).toContain(
        "stayed behind",
      );
      expect(sent).toContainEqual({
        type: "data-request",
        peer: LOG,
        "from-seq": 0,
      });
      expect(router.stalledLogs().map((s) => s.announcedHead)).toEqual([HEAD]);
    } finally {
      router.stop();
    }
  });

  it("reports nothing when this side's head has caught up", async () => {
    const errors: Error[] = [];
    const ledger: AccountLedgerReplica = {
      ownsLog: () => true,
      handleDataFrame: async () => null,
      announcements: async () => [have()],
    };
    const router = new DataFrameRouter({
      dataStorage: undefined,
      account: { ledger: () => ledger, isAccountPeer: async () => true },
      peerSessions: new Map([[SENDER_HEX, true]]),
      onError: (error) => {
        errors.push(error);
      },
      hub: undefined,
      announceIntervalMs: ROUND_MS,
    });
    try {
      await router.route(
        {
          peerDeviceId: SENDER_BYTES,
          send: async () => undefined,
        } as unknown as Connection,
        have(),
      );
      await new Promise<void>((resolve) => {
        setTimeout(resolve, ROUND_MS * ROUNDS_TO_WAIT);
      });

      expect(errors).toEqual([]);
      expect(router.stalledLogs()).toEqual([]);
    } finally {
      router.stop();
    }
  });
});

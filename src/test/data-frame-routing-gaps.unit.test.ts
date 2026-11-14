/**
 * The router records the head every account peer announces, on a direct connection and through the relay hub, before the ledger answers, and only for an account peer's frame for one of the account's logs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
/** A writer log this side holds, which the stalled log of these tests is not. */
const OTHER_LOG = Uint8Array.from(Buffer.from("0909", "hex"));

function have(): DataHaveFrame {
  return { type: "data-have", peer: LOG, "head-seq": HEAD };
}

function account(options: Readonly<{ owns: boolean; peer: boolean }>) {
  const ledger: AccountLedgerReplica = {
    ownsLog: () => options.owns,
    handleDataFrame: async () => null,
    announcements: async () => [],
    unreadableEntries: () => [],
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
  const ROUNDS_TO_RUN = 8;
  /** Enough turns of the microtask queue for one round, whose steps all resolve without I/O, to finish before the next tick. */
  const MICROTASK_TURNS = 200;
  const SILENT_SEED = 1;
  const REFUSING_SEED = 2;
  const DROPPING_SEED = 3;
  const BROKEN_SEED = 4;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Runs `count` ticks of the router's interval, each to completion. */
  async function runRounds(count: number): Promise<void> {
    for (let round = 0; round < count; round += 1) {
      vi.advanceTimersByTime(ROUND_MS);
      for (let turn = 0; turn < MICROTASK_TURNS; turn += 1) {
        await Promise.resolve();
      }
    }
  }

  function deviceBytes(seed: number): Uint8Array {
    return Uint8Array.from({ length: DEVICE_ID_BYTES }, () => seed);
  }

  function hex(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("hex");
  }

  function routerFor(
    announcements: AccountLedgerReplica["announcements"],
    peerSessions: Map<string, true>,
    errors: Readonly<{ push: (error: Error) => unknown }>,
    isAccountPeer: () => boolean = () => true,
  ): DataFrameRouter {
    const ledger: AccountLedgerReplica = {
      ownsLog: () => true,
      handleDataFrame: async () => null,
      announcements,
      unreadableEntries: () => [],
    };
    return new DataFrameRouter({
      dataStorage: undefined,
      account: {
        ledger: () => ledger,
        isAccountPeer: async () => isAccountPeer(),
      },
      peerSessions,
      onError: (error) => {
        errors.push(error);
      },
      hub: undefined,
      announceIntervalMs: ROUND_MS,
    });
  }

  function stallReports(errors: readonly Error[]): Error[] {
    return errors.filter((e) => e.message.includes("stayed behind"));
  }

  it("reports a log that stays behind and asks the peer that announced it for the entries, over its direct connection", async () => {
    const sent: unknown[] = [];
    const connection = {
      peerDeviceId: SENDER_BYTES,
      send: async (frame: unknown) => {
        sent.push(frame);
      },
    } as unknown as Connection;
    const errors: Error[] = [];
    // This side holds nothing of the log, so every announcement is empty.
    const router = routerFor(
      async () => [],
      new Map([[SENDER_HEX, true]]),
      errors,
    );
    try {
      await router.route(connection, have());
      await runRounds(ROUNDS_TO_RUN);

      expect(stallReports(errors)).toHaveLength(1);
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
    const router = routerFor(
      async () => [have()],
      new Map([[SENDER_HEX, true]]),
      errors,
    );
    try {
      await router.route(
        {
          peerDeviceId: SENDER_BYTES,
          send: async () => undefined,
        } as unknown as Connection,
        have(),
      );
      await runRounds(ROUNDS_TO_RUN);

      expect(errors).toEqual([]);
      expect(router.stalledLogs()).toEqual([]);
    } finally {
      router.stop();
    }
  });

  it("does not count a round in which every offer failed as a stall, and counts again once they go through", async () => {
    let failing = true;
    const errors: Error[] = [];
    const connection = {
      peerDeviceId: SENDER_BYTES,
      send: async () => {
        if (failing) throw new Error("the connection dropped");
      },
    } as unknown as Connection;
    // This side holds another log, so every round offers it and the offer fails while `failing`.
    const router = routerFor(
      async () => [{ type: "data-have", peer: OTHER_LOG, "head-seq": 1 }],
      new Map([[SENDER_HEX, true]]),
      errors,
    );
    try {
      await router.route(connection, have());
      await runRounds(ROUNDS_TO_RUN);
      expect(errors.some((e) => e.message === "the connection dropped")).toBe(
        true,
      );
      expect(stallReports(errors)).toEqual([]);
      expect(router.stalledLogs()).toEqual([]);

      failing = false;
      await runRounds(ROUNDS_TO_RUN);
      expect(stallReports(errors)).toHaveLength(1);
      expect(router.stalledLogs()).toHaveLength(1);
    } finally {
      router.stop();
    }
  });

  it("still counts every round while another device is reached, however the other devices fail: one never answers, one refuses, one drops its session", async () => {
    const errors: Error[] = [];
    const [silent, refusing, dropping] = [
      deviceBytes(SILENT_SEED),
      deviceBytes(REFUSING_SEED),
      deviceBytes(DROPPING_SEED),
    ];
    const sessions = new Map<string, true>([
      [SENDER_HEX, true],
      [hex(silent), true],
      [hex(refusing), true],
      [hex(dropping), true],
    ]);
    const router = routerFor(
      async () => [{ type: "data-have", peer: OTHER_LOG, "head-seq": 1 }],
      sessions,
      errors,
    );
    const connectionOf = (
      id: Uint8Array,
      send: () => Promise<void>,
    ): Connection => ({ peerDeviceId: id, send }) as unknown as Connection;
    try {
      await router.route(
        connectionOf(SENDER_BYTES, async () => undefined),
        have(),
      );
      await router.route(
        connectionOf(silent, async () => undefined),
        have(),
      );
      await router.route(
        connectionOf(refusing, async () => {
          throw new Error("refused");
        }),
        have(),
      );
      await router.route(
        connectionOf(dropping, async () => undefined),
        have(),
      );
      sessions.delete(hex(dropping));
      await runRounds(ROUNDS_TO_RUN);

      expect(stallReports(errors)).toHaveLength(1);
      expect(router.stalledLogs()).toHaveLength(1);
    } finally {
      router.stop();
    }
  });

  it("still counts every round when reading one device's membership or the hub's peers throws", async () => {
    const errors: Error[] = [];
    const broken = deviceBytes(BROKEN_SEED);
    const sessions = new Map<string, true>([
      [SENDER_HEX, true],
      [hex(broken), true],
    ]);
    const ledger: AccountLedgerReplica = {
      ownsLog: () => true,
      handleDataFrame: async () => null,
      announcements: async () => [
        { type: "data-have", peer: OTHER_LOG, "head-seq": 1 },
      ],
      unreadableEntries: () => [],
    };
    const router = new DataFrameRouter({
      dataStorage: undefined,
      account: {
        ledger: () => ledger,
        isAccountPeer: async (deviceHex) => {
          if (deviceHex === hex(broken)) {
            throw new Error("membership unreadable");
          }
          return true;
        },
      },
      peerSessions: sessions,
      onError: (error) => {
        errors.push(error);
      },
      hub: {
        peers: () => {
          throw new Error("hub listing unreadable");
        },
        send: async () => undefined,
      },
      announceIntervalMs: ROUND_MS,
    });
    const connectionOf = (id: Uint8Array): Connection =>
      ({
        peerDeviceId: id,
        send: async () => undefined,
      }) as unknown as Connection;
    try {
      await router.route(connectionOf(SENDER_BYTES), have());
      await router.route(connectionOf(broken), have());
      await runRounds(ROUNDS_TO_RUN);

      expect(errors.map((e) => e.message)).toContain("membership unreadable");
      expect(errors.map((e) => e.message)).toContain("hub listing unreadable");
      expect(stallReports(errors)).toHaveLength(1);
      expect(router.stalledLogs()).toHaveLength(1);
    } finally {
      router.stop();
    }
  });

  it("counts no round while no peer of the account can be reached at all", async () => {
    const errors: Error[] = [];
    let accountPeer = true;
    const router = routerFor(
      async () => [{ type: "data-have", peer: OTHER_LOG, "head-seq": 1 }],
      new Map([[SENDER_HEX, true]]),
      errors,
      () => accountPeer,
    );
    try {
      await router.route(
        {
          peerDeviceId: SENDER_BYTES,
          send: async () => undefined,
        } as unknown as Connection,
        have(),
      );
      accountPeer = false;
      await runRounds(ROUNDS_TO_RUN);

      expect(errors).toEqual([]);
      expect(router.stalledLogs()).toEqual([]);
    } finally {
      router.stop();
    }
  });

  it("reads this side's heads once a round", async () => {
    const errors: Error[] = [];
    let reads = 0;
    const router = routerFor(
      async () => {
        reads += 1;
        return [];
      },
      new Map([[SENDER_HEX, true]]),
      errors,
    );
    try {
      await router.route(
        {
          peerDeviceId: SENDER_BYTES,
          send: async () => undefined,
        } as unknown as Connection,
        have(),
      );
      await runRounds(ROUNDS_TO_RUN);

      expect(reads).toBe(ROUNDS_TO_RUN);
    } finally {
      router.stop();
    }
  });

  it("reports a round whose own heads cannot be read, as that, and keeps checking in the next round", async () => {
    let unreadable = true;
    const errors: Error[] = [];
    const router = routerFor(
      async () => {
        if (unreadable) throw new Error("the ledger store is unreadable");
        return [];
      },
      new Map([[SENDER_HEX, true]]),
      errors,
    );
    try {
      await router.route(
        {
          peerDeviceId: SENDER_BYTES,
          send: async () => undefined,
        } as unknown as Connection,
        have(),
      );
      await runRounds(ROUNDS_TO_RUN);
      expect(
        errors.some((e) => e.message === "the ledger store is unreadable"),
      ).toBe(true);
      expect(router.stalledLogs()).toEqual([]);

      unreadable = false;
      await runRounds(ROUNDS_TO_RUN);
      expect(router.stalledLogs()).toHaveLength(1);
    } finally {
      router.stop();
    }
  });
});

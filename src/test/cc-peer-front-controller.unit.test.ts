/**
 * Unit tests for CcPeerFront -- the coordinator-only periodic controller (front-controller.ts) that attaches/detaches fronted sessions on each tick, driven by injected roster/probe/attach/detach/inbound-routing dependencies so it's testable with fake timers and no real cc-peer/MeshStore involved.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CcPeerFront,
  type CcPeerFrontDeps,
  type FrontedSessionRecord,
} from "../bridges/cc-peer/front-controller.js";
import type { CcPeerRosterEntryLike } from "../bridges/cc-peer/front.js";

const POLL_INTERVAL_MS = 5000;
/** How many poll intervals stop() must survive with zero further polling -- arbitrary beyond "more than one", chosen to make a lingering timer's own recurrence visible rather than a one-off fluke (matches stale-agent-checker.test.ts's own HALT_CHECK_INTERVAL_COUNT convention). */
const HALT_CHECK_INTERVAL_COUNT = 3;
/** A pid standing in for a real live agent-comms bridge holding a slot's lock -- arbitrary beyond "a plausible process id", used only to prove the yield path treats "probe returned a pid" as "session now fronts itself". */
const LIVE_LOCK_HOLDER_PID = 4242;

function rosterEntry(
  overrides: Readonly<Partial<CcPeerRosterEntryLike>> = {},
): CcPeerRosterEntryLike {
  return {
    pid: 111,
    cwd: "/tmp/project",
    version: "2.1.269",
    messagingSocketPath: "/tmp/sock-111",
    ...overrides,
  };
}

interface StubRecord extends FrontedSessionRecord {
  detached: boolean;
}

/** Unwraps the resolved value of a mocked attach() call's Nth invocation, asserting it actually happened -- vi's own mock.results indexing returns undefined for a call that never occurred, which every call site here has already asserted against via toHaveBeenCalledTimes. */
async function attachResult(
  attach: ReturnType<typeof vi.fn<CcPeerFrontDeps<StubRecord>["attach"]>>,
  callIndex = 0,
): Promise<StubRecord> {
  const value = await attach.mock.results[callIndex]?.value;
  if (value === undefined) {
    throw new Error(`attach() was never called at index ${String(callIndex)}`);
  }
  return value;
}

function stubRecord(entry: Readonly<CcPeerRosterEntryLike>): StubRecord {
  return {
    pid: entry.pid,
    cwd: entry.cwd,
    messagingSocketPath: entry.messagingSocketPath,
    handleInbound: vi.fn<FrontedSessionRecord["handleInbound"]>(),
    handleAliasReply: vi.fn<FrontedSessionRecord["handleAliasReply"]>(),
    notifyStaleAlias: vi.fn<FrontedSessionRecord["notifyStaleAlias"]>(),
    detached: false,
  };
}

interface Harness {
  front: CcPeerFront<StubRecord>;
  deps: CcPeerFrontDeps<StubRecord>;
  roster: CcPeerRosterEntryLike[];
  attach: ReturnType<typeof vi.fn<CcPeerFrontDeps<StubRecord>["attach"]>>;
  detach: ReturnType<typeof vi.fn<CcPeerFrontDeps<StubRecord>["detach"]>>;
  probeSlotOwner: ReturnType<
    typeof vi.fn<CcPeerFrontDeps<StubRecord>["probeSlotOwner"]>
  >;
  onError: ReturnType<
    typeof vi.fn<NonNullable<CcPeerFrontDeps<StubRecord>["onError"]>>
  >;
  correspondentFor: ReturnType<
    typeof vi.fn<
      CcPeerFrontDeps<StubRecord>["aliasDirectory"]["correspondentFor"]
    >
  >;
}

function harness(initialRoster: readonly CcPeerRosterEntryLike[]): Harness {
  const roster = [...initialRoster];
  const attach = vi.fn<CcPeerFrontDeps<StubRecord>["attach"]>(async (entry) =>
    Promise.resolve(stubRecord(entry)),
  );
  const detach = vi.fn<CcPeerFrontDeps<StubRecord>["detach"]>(
    async (record) => {
      record.detached = true;
      return Promise.resolve();
    },
  );
  const probeSlotOwner = vi.fn<CcPeerFrontDeps<StubRecord>["probeSlotOwner"]>(
    () => undefined,
  );
  const onError = vi.fn<NonNullable<CcPeerFrontDeps<StubRecord>["onError"]>>();
  const correspondentFor = vi.fn<
    CcPeerFrontDeps<StubRecord>["aliasDirectory"]["correspondentFor"]
  >(() => undefined);
  const deps: CcPeerFrontDeps<StubRecord> = {
    listRoster: async () => Promise.resolve([...roster]),
    probeSlotOwner,
    attach,
    detach,
    aliasDirectory: { correspondentFor },
    pollIntervalMs: POLL_INTERVAL_MS,
    onError,
  };
  return {
    front: new CcPeerFront(deps),
    deps,
    roster,
    attach,
    detach,
    probeSlotOwner,
    onError,
    correspondentFor,
  };
}

describe("CcPeerFront — start/stop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does nothing until start() is called", async () => {
    const h = harness([rosterEntry()]);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
    expect(h.attach).not.toHaveBeenCalled();
    h.front.stop();
  });

  it("attaches a session on the first poll tick", async () => {
    const h = harness([rosterEntry({ pid: 1 })]);
    h.front.start();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(h.attach).toHaveBeenCalledTimes(1);
    await h.front.stop();
  });

  it("calling start() twice does not create a second timer", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const h = harness([]);
    h.front.start();
    h.front.start();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    await h.front.stop();
  });

  it("stop() halts further polling", async () => {
    const h = harness([rosterEntry({ pid: 1 })]);
    h.front.start();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(h.attach).toHaveBeenCalledTimes(1);
    await h.front.stop();
    await vi.advanceTimersByTimeAsync(
      POLL_INTERVAL_MS * HALT_CHECK_INTERVAL_COUNT,
    );
    expect(h.attach).toHaveBeenCalledTimes(1);
  });

  it("stop() detaches every currently-fronted session", async () => {
    const h = harness([rosterEntry({ pid: 1 })]);
    h.front.start();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(h.attach).toHaveBeenCalledTimes(1);
    const record = await attachResult(h.attach);

    await h.front.stop();

    expect(h.detach).toHaveBeenCalledTimes(1);
    expect(record.detached).toBe(true);
  });
});

describe("CcPeerFront — attach/detach diffing across ticks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not re-attach a session already fronted from a previous tick", async () => {
    const h = harness([rosterEntry({ pid: 1 })]);
    h.front.start();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(h.attach).toHaveBeenCalledTimes(1);
    await h.front.stop();
  });

  it("attaches a session that appears in the roster on a later tick", async () => {
    const h = harness([]);
    h.front.start();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(h.attach).not.toHaveBeenCalled();

    h.roster.push(rosterEntry({ pid: 2 }));
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(h.attach).toHaveBeenCalledTimes(1);
    await h.front.stop();
  });

  it("detaches a session that has exited (no longer in the roster)", async () => {
    const h = harness([rosterEntry({ pid: 1 })]);
    h.front.start();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(h.attach).toHaveBeenCalledTimes(1);

    h.roster.length = 0;
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(h.detach).toHaveBeenCalledTimes(1);
    await h.front.stop();
  });

  it("yields a session the moment its own slot is claimed by a live bridge, without re-attaching it", async () => {
    const h = harness([rosterEntry({ pid: 1, cwd: "/tmp/yields" })]);
    h.front.start();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(h.attach).toHaveBeenCalledTimes(1);
    const record = await attachResult(h.attach);

    // A real agent-comms bridge has since taken the slot over -- the probe now reports its pid.
    h.probeSlotOwner.mockReturnValue(LIVE_LOCK_HOLDER_PID);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(h.detach).toHaveBeenCalledTimes(1);
    expect(record.detached).toBe(true);
    expect(h.attach).toHaveBeenCalledTimes(1);

    // Even if the slot frees up again later, this front never re-attaches on its own within the same run -- the session is expected to keep its own bridge running from here.
    h.probeSlotOwner.mockReturnValue(undefined);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(h.attach).toHaveBeenCalledTimes(2);
    await h.front.stop();
  });

  it("routes an inbound message to the fronted session it came from", async () => {
    const h = harness([
      rosterEntry({ pid: 1, messagingSocketPath: "/tmp/sock-1" }),
    ]);
    h.front.start();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    const record = await attachResult(h.attach);

    h.front.handleInboundMessage({ from: "uds:/tmp/sock-1", body: "hi" });

    expect(record.handleInbound).toHaveBeenCalledWith({
      from: "uds:/tmp/sock-1",
      body: "hi",
    });
    await h.front.stop();
  });

  it("silently ignores an inbound message matching no fronted session", async () => {
    const h = harness([]);
    expect(() =>
      h.front.handleInboundMessage({ from: "uds:/tmp/unknown", body: "hi" }),
    ).not.toThrow();
  });

  it("reports a roster failure via onError rather than throwing out of the poll timer", async () => {
    const h = harness([]);
    const failure = new Error("roster unavailable");
    h.deps.listRoster = async () => Promise.reject(failure);
    h.front.start();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(h.onError).toHaveBeenCalledWith(failure);
    await h.front.stop();
  });

  it("reports an attach failure via onError without losing track of other sessions", async () => {
    const h = harness([
      rosterEntry({ pid: 1, cwd: "/tmp/a" }),
      rosterEntry({ pid: 2, cwd: "/tmp/b" }),
    ]);
    const failure = new Error("cc-peer send failed");
    h.attach.mockImplementationOnce(async () => Promise.reject(failure));
    h.front.start();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(h.onError).toHaveBeenCalledWith(failure);
    expect(h.attach).toHaveBeenCalledTimes(2);
    await h.front.stop();
  });
});

describe("CcPeerFront — handleAliasMessage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("routes an alias reply to the fronted session it came from, resolving the correspondent via the alias directory", async () => {
    const h = harness([
      rosterEntry({ pid: 1, messagingSocketPath: "/tmp/sock-1" }),
    ]);
    h.correspondentFor.mockReturnValue("correspondent-1");
    h.front.start();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    const record = await attachResult(h.attach);

    h.front.handleAliasMessage({
      alias: "mesh-correspond",
      from: "uds:/tmp/sock-1",
      body: "reply body",
    });

    expect(h.correspondentFor).toHaveBeenCalledWith("mesh-correspond");
    expect(record.handleAliasReply).toHaveBeenCalledWith("correspondent-1", {
      alias: "mesh-correspond",
      from: "uds:/tmp/sock-1",
      body: "reply body",
    });
    expect(record.notifyStaleAlias).not.toHaveBeenCalled();
    await h.front.stop();
  });

  it("notifies the fronted session of a stale alias when the directory no longer knows the correspondent", async () => {
    const h = harness([
      rosterEntry({ pid: 1, messagingSocketPath: "/tmp/sock-1" }),
    ]);
    h.correspondentFor.mockReturnValue(undefined);
    h.front.start();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    const record = await attachResult(h.attach);

    h.front.handleAliasMessage({
      alias: "mesh-stale",
      from: "uds:/tmp/sock-1",
      body: "reply body",
    });

    expect(record.notifyStaleAlias).toHaveBeenCalledWith("mesh-stale");
    expect(record.handleAliasReply).not.toHaveBeenCalled();
    await h.front.stop();
  });

  it("silently ignores an alias message matching no fronted session", async () => {
    const h = harness([]);
    expect(() =>
      h.front.handleAliasMessage({
        alias: "mesh-unknown",
        from: "uds:/tmp/unknown",
        body: "hi",
      }),
    ).not.toThrow();
    expect(h.correspondentFor).not.toHaveBeenCalled();
  });
});

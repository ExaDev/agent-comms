/**
 * Unit tests for the cc-peer front's pure decision logic (bridges/cc-peer/front.ts) -- roster filtering, slot computation, and inbound message routing, all tested purely over data with no real cc-peer/MeshStore/filesystem involved.
 */
import { describe, expect, it } from "vitest";
import {
  isCcPeerLibraryPeer,
  computeFrontSlot,
  selectSessionsToFront,
  matchInboundMessageSession,
  type CcPeerRosterEntryLike,
} from "../bridges/cc-peer/front.js";

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

/** A pid standing in for a real live agent-comms bridge holding a slot's lock -- arbitrary beyond "a plausible process id", used only to prove selectSessionsToFront treats "probe returned a pid" as "already fronted", not to assert anything about the value itself. */
const LIVE_LOCK_HOLDER_PID = 4242;

describe("isCcPeerLibraryPeer", () => {
  it("is true for an entry carrying cc-peer's own literal version marker", () => {
    expect(isCcPeerLibraryPeer(rosterEntry({ version: "cc-peer" }))).toBe(true);
  });

  it("is false for an entry reporting a real Claude Code version", () => {
    expect(isCcPeerLibraryPeer(rosterEntry({ version: "2.1.269" }))).toBe(
      false,
    );
  });
});

describe("computeFrontSlot", () => {
  it("uses the claude-code harness, matching the real claude-code bridge's own slot", () => {
    expect(computeFrontSlot("/tmp/project")).toEqual({
      harness: "claude-code",
      cwd: "/tmp/project",
    });
  });

  it("is distinct per cwd", () => {
    expect(computeFrontSlot("/tmp/a")).not.toEqual(computeFrontSlot("/tmp/b"));
  });
});

describe("selectSessionsToFront", () => {
  it("excludes cc-peer-library peers regardless of slot state", () => {
    const libraryPeer = rosterEntry({ pid: 1, version: "cc-peer" });
    const selected = selectSessionsToFront([libraryPeer], () => undefined);
    expect(selected).toEqual([]);
  });

  it("excludes a real session whose own slot is already held by a live bridge", () => {
    const alreadyFronted = rosterEntry({ pid: 2, cwd: "/tmp/self-fronted" });
    const selected = selectSessionsToFront([alreadyFronted], (slot) =>
      slot.cwd === "/tmp/self-fronted" ? LIVE_LOCK_HOLDER_PID : undefined,
    );
    expect(selected).toEqual([]);
  });

  it("selects a real session whose own slot is unheld", () => {
    const unfronted = rosterEntry({ pid: 3, cwd: "/tmp/unfronted" });
    const selected = selectSessionsToFront([unfronted], () => undefined);
    expect(selected).toEqual([unfronted]);
  });

  it("probes the slot computed from the entry's own cwd, not an unrelated one", () => {
    const entry = rosterEntry({ pid: 4, cwd: "/tmp/watched" });
    let probedSlot: { harness: string; cwd: string } | undefined;
    selectSessionsToFront([entry], (slot) => {
      probedSlot = slot;
      return undefined;
    });
    expect(probedSlot).toEqual({ harness: "claude-code", cwd: "/tmp/watched" });
  });

  it("handles a mixed roster, keeping only the unfronted real sessions", () => {
    const libraryPeer = rosterEntry({ pid: 1, version: "cc-peer" });
    const selfFronted = rosterEntry({ pid: 2, cwd: "/tmp/self-fronted" });
    const unfronted = rosterEntry({ pid: 3, cwd: "/tmp/unfronted" });
    const selected = selectSessionsToFront(
      [libraryPeer, selfFronted, unfronted],
      (slot) =>
        slot.cwd === "/tmp/self-fronted" ? LIVE_LOCK_HOLDER_PID : undefined,
    );
    expect(selected).toEqual([unfronted]);
  });
});

interface FrontedRecordStub {
  messagingSocketPath: string;
  label: string;
}

describe("matchInboundMessageSession", () => {
  it("matches a fronted session by the uds:<socketPath> envelope convention", () => {
    const a: FrontedRecordStub = {
      messagingSocketPath: "/tmp/sock-a",
      label: "a",
    };
    const b: FrontedRecordStub = {
      messagingSocketPath: "/tmp/sock-b",
      label: "b",
    };
    const match = matchInboundMessageSession([a, b], {
      from: "uds:/tmp/sock-b",
    });
    expect(match).toBe(b);
  });

  it("returns undefined when no fronted session's socket matches", () => {
    const a: FrontedRecordStub = {
      messagingSocketPath: "/tmp/sock-a",
      label: "a",
    };
    const match = matchInboundMessageSession([a], {
      from: "uds:/tmp/sock-unknown",
    });
    expect(match).toBeUndefined();
  });

  it("returns undefined when the message carries no from field at all", () => {
    const a: FrontedRecordStub = {
      messagingSocketPath: "/tmp/sock-a",
      label: "a",
    };
    expect(matchInboundMessageSession([a], {})).toBeUndefined();
  });

  it("never matches a from value missing the uds: prefix, even with an otherwise identical path", () => {
    const a: FrontedRecordStub = {
      messagingSocketPath: "/tmp/sock-a",
      label: "a",
    };
    expect(
      matchInboundMessageSession([a], { from: "/tmp/sock-a" }),
    ).toBeUndefined();
  });
});

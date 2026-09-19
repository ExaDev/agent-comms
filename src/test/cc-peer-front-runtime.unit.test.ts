/**
 * Unit tests for createDefaultCcPeerFront's peer ownership: a peer lent by the host process is used for the roster, never stopped by the front, and given the front's inbound listener exactly once. Every roster entry here is excluded, so nothing is ever attached and no mesh or identity is created.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultCcPeerFront,
  type FrontCcPeer,
} from "../bridges/cc-peer/front-runtime.js";
import type { CcPeerRosterEntryLike } from "../bridges/cc-peer/front.js";

const POLL_INTERVAL_MS = 1000;
/** Full start/stop cycles the listener-registration test runs -- more than one, since a single cycle cannot show a listener being added again on restart. */
const RESTART_CYCLES = 3;

const SESSION: CcPeerRosterEntryLike = {
  pid: 4242,
  cwd: "/tmp/front-runtime-unit-test",
  version: "2.1.278",
  messagingSocketPath: "/tmp/cc-socks/4242.sock",
};

function borrowedPeer(): FrontCcPeer & {
  roster: ReturnType<typeof vi.fn<FrontCcPeer["roster"]>>;
  on: ReturnType<typeof vi.fn<FrontCcPeer["on"]>>;
  stop: ReturnType<typeof vi.fn<FrontCcPeer["stop"]>>;
} {
  return {
    roster: vi.fn<FrontCcPeer["roster"]>(async () =>
      Promise.resolve([SESSION]),
    ),
    on: vi.fn<FrontCcPeer["on"]>(),
    send: vi.fn<FrontCcPeer["send"]>(async () =>
      Promise.resolve({ msgId: "m" }),
    ),
    stop: vi.fn<FrontCcPeer["stop"]>(async () => Promise.resolve()),
  };
}

describe("createDefaultCcPeerFront with a borrowed peer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads the roster from the borrowed peer and consults excludeSession for each session", async () => {
    const peer = borrowedPeer();
    const excludeSession = vi.fn(() => true);
    const front = createDefaultCcPeerFront({
      peer,
      excludeSession,
      pollIntervalMs: POLL_INTERVAL_MS,
    });

    front.start();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(peer.roster).toHaveBeenCalledTimes(1);
    expect(excludeSession).toHaveBeenCalledWith(SESSION);
    await front.stop();
  });

  it("never stops a peer it only borrowed", async () => {
    const peer = borrowedPeer();
    const front = createDefaultCcPeerFront({
      peer,
      excludeSession: () => true,
      pollIntervalMs: POLL_INTERVAL_MS,
    });

    front.start();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await front.stop();

    expect(peer.stop).not.toHaveBeenCalled();
  });

  it("attaches its inbound listener to the borrowed peer once, however many times the front is restarted", async () => {
    const peer = borrowedPeer();
    const front = createDefaultCcPeerFront({
      peer,
      excludeSession: () => true,
      pollIntervalMs: POLL_INTERVAL_MS,
    });

    for (let cycle = 0; cycle < RESTART_CYCLES; cycle += 1) {
      front.start();
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      await front.stop();
    }

    expect(peer.on).toHaveBeenCalledTimes(1);
    expect(peer.on).toHaveBeenCalledWith("message", expect.any(Function));
  });
});

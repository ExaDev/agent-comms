/**
 * Unit tests for HubLink (agent-comms#293): the per-store loop that holds a hub session, against a fake session so the dial, the loss of a session and the backoff between dials are all driven directly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HUB_LINK_POLL_INTERVAL_MS,
  HUB_RECONNECT_INITIAL_DELAY_MS,
  HUB_RECONNECT_MAX_DELAY_MS,
  HubLink,
  type HubLinkSession,
} from "../core/hub-link.js";

const HUB_URL = "wss://hub.example.com/";

/** A hub session whose dials succeed or fail as scripted and whose live session ends only when the test says so. */
class FakeHub implements HubLinkSession {
  dials: string[] = [];
  disconnects = 0;
  private failuresLeft = 0;
  private live = false;
  private endSession: (() => void) | undefined;

  get isConnected(): boolean {
    return this.live;
  }

  /** Makes the next `count` dials fail before one succeeds. */
  failNextDials(count: number): void {
    this.failuresLeft = count;
  }

  async connect(url: string): Promise<void> {
    this.dials.push(url);
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw new Error("hub unreachable");
    }
    this.live = true;
  }

  async disconnect(): Promise<void> {
    this.disconnects += 1;
    this.dropSession();
  }

  async whenDisconnected(): Promise<void> {
    if (!this.live) return;
    await new Promise<void>((resolve) => {
      this.endSession = resolve;
    });
  }

  /** The hub closing the session from its end. */
  dropSession(): void {
    this.live = false;
    this.endSession?.();
    this.endSession = undefined;
  }
}

function newLink(
  hub: FakeHub,
  shouldConnect: () => boolean = () => true,
): {
  link: HubLink;
  connected: () => number;
  errors: Error[];
} {
  let connectedCount = 0;
  const errors: Error[] = [];
  const link = new HubLink({
    hub,
    url: HUB_URL,
    shouldConnect,
    onConnected: () => {
      connectedCount += 1;
    },
    onError: (error) => {
      errors.push(error);
    },
  });
  return { link, connected: () => connectedCount, errors };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("HubLink", () => {
  it("dials the configured hub in the background and reports the connection", async () => {
    const hub = new FakeHub();
    const { link, connected } = newLink(hub);

    link.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(hub.dials).toEqual([HUB_URL]);
    expect(connected()).toBe(1);
    await link.stop();
  });

  it("does nothing on a second start while already running", async () => {
    const hub = new FakeHub();
    const { link } = newLink(hub);

    link.start();
    link.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(hub.dials).toHaveLength(1);
    await link.stop();
  });

  it("dials again after the hub ends the session, once the initial delay has passed", async () => {
    const hub = new FakeHub();
    const { link, connected } = newLink(hub);
    link.start();
    await vi.advanceTimersByTimeAsync(0);

    hub.dropSession();
    await vi.advanceTimersByTimeAsync(HUB_RECONNECT_INITIAL_DELAY_MS - 1);
    expect(hub.dials).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(hub.dials).toHaveLength(2);
    expect(connected()).toBe(2);
    await link.stop();
  });

  it("reports a failed dial and retries, doubling the delay each time up to the ceiling", async () => {
    const hub = new FakeHub();
    const failures = 8;
    hub.failNextDials(failures);
    const { link, errors } = newLink(hub);

    link.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toHaveLength(1);

    let delayMs = HUB_RECONNECT_INITIAL_DELAY_MS;
    for (let attempt = 1; attempt < failures; attempt += 1) {
      await vi.advanceTimersByTimeAsync(delayMs - 1);
      expect(hub.dials).toHaveLength(attempt);
      await vi.advanceTimersByTimeAsync(1);
      expect(hub.dials).toHaveLength(attempt + 1);
      delayMs = Math.min(delayMs * 2, HUB_RECONNECT_MAX_DELAY_MS);
    }

    expect(errors).toHaveLength(failures);
    expect(delayMs).toBe(HUB_RECONNECT_MAX_DELAY_MS);
    await link.stop();
  });

  it("starts the backoff over after a session has been established", async () => {
    const hub = new FakeHub();
    hub.failNextDials(2);
    const { link } = newLink(hub);
    link.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(HUB_RECONNECT_INITIAL_DELAY_MS);
    await vi.advanceTimersByTimeAsync(HUB_RECONNECT_INITIAL_DELAY_MS * 2);
    expect(hub.isConnected).toBe(true);

    const dialsBeforeDrop = hub.dials.length;
    hub.dropSession();
    await vi.advanceTimersByTimeAsync(HUB_RECONNECT_INITIAL_DELAY_MS);

    expect(hub.dials).toHaveLength(dialsBeforeDrop + 1);
    await link.stop();
  });

  it("stops without waiting out a pending delay, and does not dial again", async () => {
    const hub = new FakeHub();
    hub.failNextDials(1);
    const { link } = newLink(hub);
    link.start();
    await vi.advanceTimersByTimeAsync(0);

    await link.stop();
    await vi.advanceTimersByTimeAsync(HUB_RECONNECT_MAX_DELAY_MS);

    expect(hub.dials).toHaveLength(1);
    expect(hub.disconnects).toBe(1);
  });

  it("drops a live session when stopped, without treating that as a loss to redial", async () => {
    const hub = new FakeHub();
    const { link } = newLink(hub);
    link.start();
    await vi.advanceTimersByTimeAsync(0);

    await link.stop();
    await vi.advanceTimersByTimeAsync(HUB_RECONNECT_MAX_DELAY_MS);

    expect(hub.isConnected).toBe(false);
    expect(hub.dials).toHaveLength(1);
  });

  it("does not dial while the store does not want a session, and dials within a poll once it does", async () => {
    const hub = new FakeHub();
    let wanted = false;
    const { link } = newLink(hub, () => wanted);
    link.start();
    await vi.advanceTimersByTimeAsync(HUB_LINK_POLL_INTERVAL_MS * 2);
    expect(hub.dials).toHaveLength(0);

    wanted = true;
    await vi.advanceTimersByTimeAsync(HUB_LINK_POLL_INTERVAL_MS);

    expect(hub.dials).toHaveLength(1);
    await link.stop();
  });

  it("dials at once on reconsider instead of waiting out the poll", async () => {
    const hub = new FakeHub();
    let wanted = false;
    const { link } = newLink(hub, () => wanted);
    link.start();
    await vi.advanceTimersByTimeAsync(0);

    wanted = true;
    link.reconsider();
    await vi.advanceTimersByTimeAsync(0);

    expect(hub.dials).toHaveLength(1);
    expect(hub.isConnected).toBe(true);
    await link.stop();
  });

  it("drops a live session when the store stops wanting one, and does not redial while it stays unwanted", async () => {
    const hub = new FakeHub();
    let wanted = true;
    const { link } = newLink(hub, () => wanted);
    link.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(hub.isConnected).toBe(true);

    wanted = false;
    link.reconsider();
    await vi.advanceTimersByTimeAsync(0);
    expect(hub.isConnected).toBe(false);
    expect(hub.disconnects).toBe(1);

    await vi.advanceTimersByTimeAsync(HUB_RECONNECT_MAX_DELAY_MS);
    expect(hub.dials).toHaveLength(1);
    await link.stop();
  });

  it("notices a session it no longer wants at the next poll when nobody calls reconsider", async () => {
    const hub = new FakeHub();
    let wanted = true;
    const { link } = newLink(hub, () => wanted);
    link.start();
    await vi.advanceTimersByTimeAsync(0);

    wanted = false;
    await vi.advanceTimersByTimeAsync(HUB_LINK_POLL_INTERVAL_MS);

    expect(hub.isConnected).toBe(false);
    await link.stop();
  });
});

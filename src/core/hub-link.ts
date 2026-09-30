/**
 * HubLink keeps one store's own session on the relay hub alive while the store should have one: it dials in the background, waits for the session to end, and dials again after a delay that doubles up to a ceiling while the hub stays unreachable. Every store owns one (agent-comms#293), because reachability from another machine has to belong to the device itself and not to whichever store on the machine happens to hold the local coordinator role.
 *
 * The store decides through shouldConnect whether it wants a session at all, and a change of mind, made in this process or by another one editing the shared trust file, is picked up within a poll interval, or at once through reconsider(). A store with nothing to say to another machine (nothing trusted, no agent, or a ghost agent) holds no session, so it puts nothing on the hub, not even its device id.
 *
 * Which hub is dialled is chosen afresh before every dial (agent-comms#342): the hub is a set of relays, ranked by relay-selection.ts, with the configured public hub as the fallback. A dial that fails, or a session the relay drops, excludes that URL from selection for the redial ceiling (the cadence an unreachable hub is retried at anyway), so a relay that has gone falls through to the next choice instead of being redialled on every pass; and a session held over one relay is moved as soon as selection prefers another.
 *
 * The dial never blocks the caller: a bridge starting up offline must not wait out a connect timeout before it can serve its tools, and a hub that is down or restarting is an ordinary, recoverable state. Failures reach onError and the loop carries on.
 */

import type { HubSession } from "./hub-session.js";

/** Delay before the first redial after a failed dial or a lost session. */
export const HUB_RECONNECT_INITIAL_DELAY_MS = 1000;

/** Ceiling the redial delay doubles up to while the hub stays unreachable, so an outage is retried about once a minute rather than backing off without bound. */
export const HUB_RECONNECT_MAX_DELAY_MS = 60_000;

/** How often a link re-evaluates shouldConnect while it has nothing to react to: a store that wants no session notices it now wants one, and a store holding one notices it no longer should, without anyone calling reconsider(). Bounds how long a trust change made by another process on the machine takes to show. */
export const HUB_LINK_POLL_INTERVAL_MS = 5000;

/** Factor the redial delay grows by after each failed dial. */
const RECONNECT_DELAY_GROWTH_FACTOR = 2;

/** The parts of a HubSession a HubLink drives. */
export type HubLinkSession = Pick<
  HubSession,
  "connect" | "disconnect" | "isConnected" | "whenDisconnected"
>;

export interface HubLinkOptions {
  hub: Readonly<HubLinkSession>;
  /** The hub to hold a session on next, given the URLs whose last dial or session failed. Read before every dial and every poll interval while connected. */
  selectUrl: (excluded: ReadonlySet<string>) => string;
  /** Whether the store wants a hub session right now. Read every poll interval and on reconsider(); a session held when this turns false is dropped, and none is dialled while it is false. */
  shouldConnect: () => boolean;
  /** Called each time a session is established, after the dial resolves, with the URL it was established to. WireMeshTransport uses it to advertise this store's presence at once instead of waiting for the next presence tick, and to know whether it holds an uplink to the public hub. */
  onConnected: (url: string) => void;
  /** Called each time an established session ends, whoever ended it. */
  onDisconnected: () => void;
  /** Reports a failed dial. Never called for anything else. */
  onError: (error: Error) => void;
  /** Overrides HUB_RECONNECT_INITIAL_DELAY_MS, for a test that must not wait a second per redial. */
  initialDelayMs?: number;
  /** Overrides HUB_RECONNECT_MAX_DELAY_MS. */
  maxDelayMs?: number;
  /** Overrides HUB_LINK_POLL_INTERVAL_MS. */
  pollIntervalMs?: number;
}

export class HubLink {
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly pollIntervalMs: number;
  private stopped = false;
  private running: Promise<void> | undefined;
  /** Cancels the wait between dials, so stop() does not sit out a delay. */
  private wake: (() => void) | undefined;
  /** When each URL's last dial failed or its session was dropped by the far end (epoch ms); a successful dial to a URL clears its entry. */
  private readonly failedAt = new Map<string, number>();

  constructor(private readonly options: Readonly<HubLinkOptions>) {
    this.initialDelayMs =
      options.initialDelayMs ?? HUB_RECONNECT_INITIAL_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? HUB_RECONNECT_MAX_DELAY_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? HUB_LINK_POLL_INTERVAL_MS;
  }

  /** Begins running in the background and returns at once. A second call while running does nothing. */
  start(): void {
    if (this.running !== undefined || this.stopped) return;
    this.running = this.run();
  }

  /** Re-evaluates shouldConnect now instead of at the next poll, and cuts short any wait, including the delay before a redial. Call it when something shouldConnect reads has changed. */
  reconsider(): void {
    this.wake?.();
  }

  /** Stops, drops the live session, and resolves once the loop has ended. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    await this.options.hub.disconnect();
    await this.running;
  }

  /** A method call rather than a direct property read, so TypeScript's control-flow narrowing does not treat the flag as staying false across the awaits in run(), during which stop() can set it. */
  private isStopped(): boolean {
    return this.stopped;
  }

  private async run(): Promise<void> {
    let delayMs = this.initialDelayMs;
    while (!this.isStopped()) {
      if (!this.options.shouldConnect()) {
        await this.sleep(this.pollIntervalMs);
        continue;
      }
      let sessionEnded = false;
      const url = this.options.selectUrl(this.excludedUrls());
      try {
        await this.options.hub.connect(url);
        if (this.options.hub.isConnected) {
          delayMs = this.initialDelayMs;
          this.failedAt.delete(url);
          this.options.onConnected(url);
          sessionEnded = await this.holdWhileWanted(url);
          this.options.onDisconnected();
        }
      } catch (error) {
        this.options.onError(
          error instanceof Error ? error : new Error(String(error)),
        );
        sessionEnded = true;
      }
      if (sessionEnded) this.failedAt.set(url, Date.now());
      if (this.isStopped()) return;
      if (!sessionEnded) continue;
      await this.sleep(delayMs);
      delayMs = Math.min(
        delayMs * RECONNECT_DELAY_GROWTH_FACTOR,
        this.maxDelayMs,
      );
    }
  }

  /** Holds the live session to url until the hub ends it, resolving true, or until the store stops wanting it or selection prefers another hub, when it drops the session itself and resolves false. */
  private async holdWhileWanted(url: string): Promise<boolean> {
    const hubEnded = this.options.hub
      .whenDisconnected()
      .then(() => "ended" as const);
    while (!this.isStopped()) {
      const outcome = await Promise.race([
        hubEnded,
        this.sleep(this.pollIntervalMs).then(() => "woke" as const),
      ]);
      if (outcome === "ended") return true;
      if (this.isStopped()) return false;
      if (
        !this.options.shouldConnect() ||
        this.options.selectUrl(this.excludedUrls()) !== url
      ) {
        await this.options.hub.disconnect();
        return false;
      }
    }
    return false;
  }

  /** The URLs that failed within the last redial ceiling. */
  private excludedUrls(): ReadonlySet<string> {
    const cutoff = Date.now() - this.maxDelayMs;
    const excluded = new Set<string>();
    for (const [url, at] of this.failedAt) {
      if (at > cutoff) excluded.add(url);
      else this.failedAt.delete(url);
    }
    return excluded;
  }

  /** Waits ms, or until reconsider() or stop() cuts it short. Each wait clears the wake handle only if it is still its own, since holdWhileWanted leaves a losing wait pending and its late end must not wipe the handle of the wait that replaced it. */
  private async sleep(ms: number): Promise<void> {
    let wakeThis: (() => void) | undefined;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref();
      wakeThis = () => {
        clearTimeout(timer);
        resolve();
      };
      this.wake = wakeThis;
    });
    if (this.wake === wakeThis) this.wake = undefined;
  }
}

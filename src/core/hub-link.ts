/**
 * HubLink keeps one store's own session on the relay hub alive: it dials in the background, waits for the session to end, and dials again after a delay that doubles up to a ceiling while the hub stays unreachable. Every store owns one (agent-comms#293), because reachability from another machine has to belong to the device itself and not to whichever store on the machine happens to hold the local coordinator role.
 *
 * The dial never blocks the caller: a bridge starting up offline must not wait out a connect timeout before it can serve its tools, and a hub that is down or restarting is an ordinary, recoverable state. Failures reach onError and the loop carries on.
 */

import type { HubSession } from "./hub-session.js";

/** Delay before the first redial after a failed dial or a lost session. */
export const HUB_RECONNECT_INITIAL_DELAY_MS = 1000;

/** Ceiling the redial delay doubles up to while the hub stays unreachable, so an outage is retried about once a minute rather than backing off without bound. */
export const HUB_RECONNECT_MAX_DELAY_MS = 60_000;

/** Factor the redial delay grows by after each failed dial. */
const RECONNECT_DELAY_GROWTH_FACTOR = 2;

/** The parts of a HubSession a HubLink drives. */
export type HubLinkSession = Pick<
  HubSession,
  "connect" | "disconnect" | "isConnected" | "whenDisconnected"
>;

export interface HubLinkOptions {
  hub: Readonly<HubLinkSession>;
  /** The hub to hold a session on. */
  url: string;
  /** Called each time a session is established, after the dial resolves. WireMeshTransport uses it to advertise this store's presence at once instead of waiting for the next presence tick. */
  onConnected: () => void;
  /** Reports a failed dial. Never called for anything else. */
  onError: (error: Error) => void;
  /** Overrides HUB_RECONNECT_INITIAL_DELAY_MS, for a test that must not wait a second per redial. */
  initialDelayMs?: number;
  /** Overrides HUB_RECONNECT_MAX_DELAY_MS. */
  maxDelayMs?: number;
}

export class HubLink {
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private stopped = false;
  private running: Promise<void> | undefined;
  /** Cancels the wait between dials, so stop() does not sit out a delay. */
  private wake: (() => void) | undefined;

  constructor(private readonly options: Readonly<HubLinkOptions>) {
    this.initialDelayMs =
      options.initialDelayMs ?? HUB_RECONNECT_INITIAL_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? HUB_RECONNECT_MAX_DELAY_MS;
  }

  /** Begins dialling in the background and returns at once. A second call while running does nothing. */
  start(): void {
    if (this.running !== undefined || this.stopped) return;
    this.running = this.run();
  }

  /** Stops redialling, drops the live session, and resolves once the loop has ended. */
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
      try {
        await this.options.hub.connect(this.options.url);
        if (this.options.hub.isConnected) {
          delayMs = this.initialDelayMs;
          this.options.onConnected();
          await this.options.hub.whenDisconnected();
        }
      } catch (error) {
        this.options.onError(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      if (this.isStopped()) return;
      await this.sleep(delayMs);
      delayMs = Math.min(
        delayMs * RECONNECT_DELAY_GROWTH_FACTOR,
        this.maxDelayMs,
      );
    }
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref();
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    this.wake = undefined;
  }
}

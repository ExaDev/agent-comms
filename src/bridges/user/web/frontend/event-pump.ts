/**
 * The loop that keeps the dashboard's event stream flowing: subscribe, apply each event, and resume from the last event id after any transport failure. Shared by the page's client and the shared worker, which read the same stream.
 */

import { getEventMeta } from "@orpc/client";

/** How long the first retry after a failed or dropped subscription waits. */
export const PUMP_RETRY_INITIAL_MS = 250;

/** The longest a retry waits, however many attempts in a row have failed. */
export const PUMP_RETRY_MAX_MS = 30_000;

/** Each consecutive failure waits this many times as long as the one before, up to {@link PUMP_RETRY_MAX_MS}. */
export const PUMP_RETRY_FACTOR = 2;

/** Resolves after `ms` of the (possibly faked) timer clock. */
async function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Consumes an event stream for as long as `isCurrent` holds, resuming by the last event id after a failure.
 *
 * A failed subscription, or a stream that drops mid-way, is retried after a wait that doubles from {@link PUMP_RETRY_INITIAL_MS} to {@link PUMP_RETRY_MAX_MS} and starts over once an event arrives, so a port that has gone away costs one timer every {@link PUMP_RETRY_MAX_MS} at most and never keeps the event loop busy. Nothing in a browser reports a closed message port or says a socket will not come back, so the pump ends only when `isCurrent` turns false (the owner disconnected or started a newer pump) or the server ends the stream normally.
 * @param subscribe - Opens the stream, resuming after `lastEventId` when one is given.
 * @param onEvent - Applies one event.
 * @param isCurrent - Whether this pump still owns the stream; checked before each event and each retry.
 */
export async function pumpEvents<Event extends object>(
  subscribe: (lastEventId: string | undefined) => Promise<AsyncIterable<Event>>,
  onEvent: (event: Event) => void,
  isCurrent: () => boolean,
): Promise<void> {
  let lastEventId: string | undefined;
  let retryDelayMs = PUMP_RETRY_INITIAL_MS;

  while (isCurrent()) {
    try {
      const events = await subscribe(lastEventId);
      for await (const event of events) {
        if (!isCurrent()) return;
        retryDelayMs = PUMP_RETRY_INITIAL_MS;
        const meta = getEventMeta(event);
        if (meta?.id !== undefined) lastEventId = meta.id;
        onEvent(event);
      }
      // The server ended the stream normally: nothing left to resume.
      return;
    } catch {
      // Transport dropped, or the subscription could not be opened: wait, then resume from lastEventId.
    }
    await wait(retryDelayMs);
    retryDelayMs = Math.min(
      retryDelayMs * PUMP_RETRY_FACTOR,
      PUMP_RETRY_MAX_MS,
    );
  }
}

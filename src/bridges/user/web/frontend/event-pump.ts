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

/** A plain function call is opaque to TypeScript's control-flow narrowing, so the abort that can flip during an await is not mistaken for "still false" at the re-check below it. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

/** Resolves after `ms` of the (possibly faked) timer clock, or at once when `signal` aborts, clearing the timer either way so nothing is retained. */
async function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Consumes an event stream until `signal` aborts, resuming by the last event id after a failure.
 *
 * A failed subscription, or a stream that drops mid-way, is retried after a wait that doubles from {@link PUMP_RETRY_INITIAL_MS} to {@link PUMP_RETRY_MAX_MS} and starts over once an event arrives, so a port that has gone away costs one timer every {@link PUMP_RETRY_MAX_MS} at most and never keeps the event loop busy. Nothing in a browser reports a closed message port or says a socket will not come back, so the pump ends only when `signal` aborts (the owner disconnected or started a newer pump; a wait in progress ends at once) or the server ends the stream normally.
 *
 * An id is recorded only after `onEvent` has applied the event. A failure thrown by `onEvent` is not a transport failure: it is passed to `onHandlerError`, and because the client's state can no longer be trusted to match the stream, the pump forgets its id and resubscribes after the same wait, which starts it again from a snapshot.
 * @param subscribe - Opens the stream, resuming after `lastEventId` when one is given.
 * @param onEvent - Applies one event.
 * @param onHandlerError - Receives what `onEvent` threw.
 * @param signal - Aborted by the owner to end the pump.
 */
export async function pumpEvents<Event extends object>(
  subscribe: (lastEventId: string | undefined) => Promise<AsyncIterable<Event>>,
  onEvent: (event: Event) => void,
  onHandlerError: (error: unknown) => void,
  signal: AbortSignal,
): Promise<void> {
  let lastEventId: string | undefined;
  let retryDelayMs = PUMP_RETRY_INITIAL_MS;

  while (!signal.aborted) {
    try {
      const events = await subscribe(lastEventId);
      let resynchronising = false;
      for await (const event of events) {
        if (isAborted(signal)) return;
        try {
          onEvent(event);
        } catch (error) {
          onHandlerError(error);
          lastEventId = undefined;
          resynchronising = true;
          break;
        }
        retryDelayMs = PUMP_RETRY_INITIAL_MS;
        const meta = getEventMeta(event);
        if (meta?.id !== undefined) lastEventId = meta.id;
      }
      // The server ended the stream normally: nothing left to resume.
      if (!resynchronising) return;
    } catch {
      // Transport dropped, or the subscription could not be opened: wait, then resume from lastEventId.
    }
    await wait(retryDelayMs, signal);
    retryDelayMs = Math.min(
      retryDelayMs * PUMP_RETRY_FACTOR,
      PUMP_RETRY_MAX_MS,
    );
  }
}

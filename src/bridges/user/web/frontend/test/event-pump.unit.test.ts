/**
 * The event pump never retries without waiting: counted in timer ticks of a faked clock, so the result does not depend on how fast the machine runs.
 */
import { withEventMeta } from "@orpc/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  PUMP_RETRY_FACTOR,
  PUMP_RETRY_INITIAL_MS,
  PUMP_RETRY_MAX_MS,
  pumpEvents,
} from "../event-pump.js";

/** Attempts made by the time the second and third waits have run. */
const SECOND_ATTEMPT = 2;
const THIRD_ATTEMPT = 3;

/** How many cap intervals the long-outage checks span. */
const CAP_INTERVALS = 10;

interface TestEvent {
  readonly n: number;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Lets every promise already resolvable run, without moving the clock. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

async function* stream(
  events: readonly TestEvent[],
  failAfter: boolean,
): AsyncGenerator<TestEvent> {
  for (const event of events) yield event;
  if (failAfter) throw new Error("transport dropped");
}

it("waits between retries of a subscription that fails at once, doubling up to the cap", async () => {
  let current = true;
  const subscribe = vi.fn(async (): Promise<AsyncIterable<TestEvent>> => {
    throw new Error("port closed");
  });
  const pumped = pumpEvents(
    subscribe,
    () => undefined,
    () => current,
  );

  await settle();
  expect(subscribe).toHaveBeenCalledTimes(1);

  await vi.advanceTimersByTimeAsync(PUMP_RETRY_INITIAL_MS - 1);
  expect(subscribe).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(subscribe).toHaveBeenCalledTimes(SECOND_ATTEMPT);

  await vi.advanceTimersByTimeAsync(PUMP_RETRY_INITIAL_MS * PUMP_RETRY_FACTOR);
  expect(subscribe).toHaveBeenCalledTimes(THIRD_ATTEMPT);

  // However long it has been failing, one attempt per cap interval at most.
  await vi.advanceTimersByTimeAsync(PUMP_RETRY_MAX_MS * CAP_INTERVALS);
  const attemptsAfterLongOutage = subscribe.mock.calls.length;
  await vi.advanceTimersByTimeAsync(PUMP_RETRY_MAX_MS * CAP_INTERVALS);
  expect(subscribe.mock.calls.length - attemptsAfterLongOutage).toBe(
    CAP_INTERVALS,
  );

  current = false;
  await vi.advanceTimersByTimeAsync(PUMP_RETRY_MAX_MS);
  await pumped;
});

it("ends once its owner no longer holds it, without another attempt", async () => {
  let current = true;
  const subscribe = vi.fn(async (): Promise<AsyncIterable<TestEvent>> => {
    throw new Error("port closed");
  });
  const pumped = pumpEvents(
    subscribe,
    () => undefined,
    () => current,
  );
  await settle();

  current = false;
  await vi.advanceTimersByTimeAsync(PUMP_RETRY_MAX_MS);
  await pumped;

  expect(subscribe).toHaveBeenCalledTimes(1);
});

it("retries after a drop mid-stream, resumes from the last event id and starts the wait over once events flow again", async () => {
  const applied: number[] = [];
  const resumedFrom: (string | undefined)[] = [];
  let attempt = 0;
  const subscribe = vi.fn(
    async (
      lastEventId: string | undefined,
    ): Promise<AsyncIterable<TestEvent>> => {
      resumedFrom.push(lastEventId);
      attempt++;
      if (attempt === 1) throw new Error("not up yet");
      if (attempt === 2) {
        return stream(
          [
            withEventMeta({ n: 1 }, { id: "a" }),
            withEventMeta({ n: 2 }, { id: "b" }),
          ],
          true,
        );
      }
      return stream([withEventMeta({ n: THIRD_ATTEMPT }, { id: "c" })], false);
    },
  );

  const pumped = pumpEvents(
    subscribe,
    (event) => {
      applied.push(event.n);
    },
    () => true,
  );
  await vi.advanceTimersByTimeAsync(PUMP_RETRY_INITIAL_MS);
  expect(subscribe).toHaveBeenCalledTimes(SECOND_ATTEMPT);
  // The first failure doubled the wait; events arriving in between start it over, so the drop after them waits the first interval again.
  await vi.advanceTimersByTimeAsync(PUMP_RETRY_INITIAL_MS);
  await pumped;

  expect(subscribe).toHaveBeenCalledTimes(THIRD_ATTEMPT);
  expect(applied).toEqual(
    Array.from({ length: THIRD_ATTEMPT }, (_, index) => index + 1),
  );
  expect(resumedFrom).toEqual([undefined, undefined, "b"]);
});

it("returns when the server ends the stream normally", async () => {
  const subscribe = vi.fn(async (): Promise<AsyncIterable<TestEvent>> =>
    stream([{ n: 1 }], false),
  );

  await pumpEvents(
    subscribe,
    () => undefined,
    () => true,
  );

  expect(subscribe).toHaveBeenCalledTimes(1);
});

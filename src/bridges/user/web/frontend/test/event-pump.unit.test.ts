/**
 * The event pump never retries without waiting: counted in timer ticks of a faked clock, so the result does not depend on how fast the machine runs. A mock that fails at once bounds its own spin, so a pump that stops waiting fails an assertion on the attempt count instead of hanging the process.
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

/** Attempts a failing mock allows within one instant before it ends the pump itself: far above any legitimate count at one tick, so reaching it means the pump is not waiting. */
const SPIN_LIMIT = 200;

interface TestEvent {
  readonly n: number;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const ignore = (): void => undefined;

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

/** A subscription that always fails at once and ends the pump after SPIN_LIMIT attempts, so a pump that does not wait is stopped rather than left spinning. */
function failingSubscription(
  controller: AbortController,
): ReturnType<typeof vi.fn<() => Promise<AsyncIterable<TestEvent>>>> {
  const subscribe = vi.fn(async (): Promise<AsyncIterable<TestEvent>> => {
    if (subscribe.mock.calls.length >= SPIN_LIMIT) controller.abort();
    throw new Error("port closed");
  });
  return subscribe;
}

it("waits between retries of a subscription that fails at once, doubling up to the cap", async () => {
  const controller = new AbortController();
  const subscribe = failingSubscription(controller);
  const pumped = pumpEvents(subscribe, ignore, ignore, controller.signal);

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

  controller.abort();
  await pumped;
});

it("ends at once when its owner aborts during a wait, leaving no timer behind", async () => {
  const controller = new AbortController();
  const subscribe = failingSubscription(controller);
  const pumped = pumpEvents(subscribe, ignore, ignore, controller.signal);
  await settle();
  expect(vi.getTimerCount()).toBe(1);

  controller.abort();
  await pumped;

  expect(vi.getTimerCount()).toBe(0);
  expect(subscribe).toHaveBeenCalledTimes(1);
});

it("does not start when its owner has already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const subscribe = failingSubscription(controller);

  await pumpEvents(subscribe, ignore, ignore, controller.signal);

  expect(subscribe).not.toHaveBeenCalled();
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
      if (attempt === SECOND_ATTEMPT) {
        return stream(
          [
            withEventMeta({ n: 1 }, { id: "a" }),
            withEventMeta({ n: SECOND_ATTEMPT }, { id: "b" }),
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
    ignore,
    new AbortController().signal,
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

it("does not resubscribe because the handler threw: it reports the failure and carries on with the next event", async () => {
  const reported: unknown[] = [];
  const applied: number[] = [];
  const failure = new Error("handler failed");
  const subscribe = vi.fn(async (): Promise<AsyncIterable<TestEvent>> =>
    stream(
      [
        withEventMeta({ n: 1 }, { id: "a" }),
        withEventMeta({ n: SECOND_ATTEMPT }, { id: "b" }),
        withEventMeta({ n: THIRD_ATTEMPT }, { id: "c" }),
      ],
      false,
    ),
  );

  await pumpEvents(
    subscribe,
    (event) => {
      if (event.n === SECOND_ATTEMPT) throw failure;
      applied.push(event.n);
    },
    (error) => {
      reported.push(error);
    },
    new AbortController().signal,
  );

  expect(subscribe).toHaveBeenCalledTimes(1);
  expect(reported).toEqual([failure]);
  expect(applied).toEqual([1, THIRD_ATTEMPT]);
});

it("resumes from the last event the handler applied, not from one it failed on", async () => {
  const resumedFrom: (string | undefined)[] = [];
  let attempt = 0;
  const subscribe = vi.fn(
    async (
      lastEventId: string | undefined,
    ): Promise<AsyncIterable<TestEvent>> => {
      resumedFrom.push(lastEventId);
      attempt++;
      if (attempt > 1) return stream([], false);
      return stream(
        [
          withEventMeta({ n: 1 }, { id: "a" }),
          withEventMeta({ n: SECOND_ATTEMPT }, { id: "b" }),
        ],
        true,
      );
    },
  );

  const pumped = pumpEvents(
    subscribe,
    (event) => {
      if (event.n === SECOND_ATTEMPT) throw new Error("handler failed");
    },
    ignore,
    new AbortController().signal,
  );
  await vi.advanceTimersByTimeAsync(PUMP_RETRY_INITIAL_MS);
  await pumped;

  expect(resumedFrom).toEqual([undefined, "a"]);
});

it("stops applying events once its owner aborts mid-stream", async () => {
  const controller = new AbortController();
  const applied: number[] = [];
  const subscribe = vi.fn(async (): Promise<AsyncIterable<TestEvent>> =>
    stream([{ n: 1 }, { n: SECOND_ATTEMPT }, { n: THIRD_ATTEMPT }], false),
  );

  await pumpEvents(
    subscribe,
    (event) => {
      applied.push(event.n);
      controller.abort();
    },
    ignore,
    controller.signal,
  );

  expect(applied).toEqual([1]);
});

it("returns when the server ends the stream normally", async () => {
  const subscribe = vi.fn(async (): Promise<AsyncIterable<TestEvent>> =>
    stream([{ n: 1 }], false),
  );

  await pumpEvents(subscribe, ignore, ignore, new AbortController().signal);

  expect(subscribe).toHaveBeenCalledTimes(1);
});

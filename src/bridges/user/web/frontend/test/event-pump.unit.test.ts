/**
 * The event pump never retries without waiting: counted in timer ticks of a faked clock, so the result does not depend on how fast the machine runs. A mock that fails at once bounds its own spin, so a pump that stops waiting fails an assertion on the attempt count instead of hanging the process.
 */
import { withEventMeta } from "@orpc/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  PUMP_HANDLER_RECOVERY_EVENTS,
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

it("resynchronises from a snapshot after the handler threw: reports it, forgets the id and resubscribes after a wait", async () => {
  const reported: unknown[] = [];
  const applied: number[] = [];
  const resumedFrom: (string | undefined)[] = [];
  const failure = new Error("handler failed");
  let attempt = 0;
  const subscribe = vi.fn(
    async (
      lastEventId: string | undefined,
    ): Promise<AsyncIterable<TestEvent>> => {
      resumedFrom.push(lastEventId);
      attempt++;
      if (attempt === 1) {
        return stream(
          [
            withEventMeta({ n: 1 }, { id: "a" }),
            withEventMeta({ n: SECOND_ATTEMPT }, { id: "b" }),
            withEventMeta({ n: THIRD_ATTEMPT }, { id: "c" }),
          ],
          false,
        );
      }
      return stream([withEventMeta({ n: SECOND_ATTEMPT }, { id: "x" })], false);
    },
  );

  const pumped = pumpEvents(
    subscribe,
    (event) => {
      if (event.n === SECOND_ATTEMPT && attempt === 1) throw failure;
      applied.push(event.n);
    },
    (error) => {
      reported.push(error);
    },
    new AbortController().signal,
  );
  await settle();
  expect(subscribe).toHaveBeenCalledTimes(1);
  // The failed event's own id, and the id before it, are both dropped: the next subscription asks for a snapshot.
  await vi.advanceTimersByTimeAsync(PUMP_RETRY_INITIAL_MS * PUMP_RETRY_FACTOR);
  await pumped;

  expect(reported).toEqual([failure]);
  expect(resumedFrom).toEqual([undefined, undefined]);
  expect(applied).toEqual([1, SECOND_ATTEMPT]);
});

it("backs off between resynchronisations when the handler keeps failing", async () => {
  const subscribe = vi.fn(async (): Promise<AsyncIterable<TestEvent>> =>
    stream([{ n: 1 }], false),
  );
  const controller = new AbortController();

  const pumped = pumpEvents(
    subscribe,
    () => {
      if (subscribe.mock.calls.length >= SPIN_LIMIT) controller.abort();
      throw new Error("handler failed");
    },
    ignore,
    controller.signal,
  );
  await settle();
  expect(subscribe).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(PUMP_RETRY_INITIAL_MS);
  expect(subscribe).toHaveBeenCalledTimes(SECOND_ATTEMPT);
  await vi.advanceTimersByTimeAsync(PUMP_RETRY_INITIAL_MS * PUMP_RETRY_FACTOR);
  expect(subscribe).toHaveBeenCalledTimes(THIRD_ATTEMPT);

  controller.abort();
  await pumped;
});

it("keeps backing off when the handler applies each snapshot and fails on a recurring later event", async () => {
  const controller = new AbortController();
  const subscribe = vi.fn(async (): Promise<AsyncIterable<TestEvent>> => {
    if (subscribe.mock.calls.length >= SPIN_LIMIT) controller.abort();
    return stream([{ n: 1 }, { n: SECOND_ATTEMPT }], false);
  });

  const pumped = pumpEvents(
    subscribe,
    (event) => {
      if (event.n === SECOND_ATTEMPT) throw new Error("cannot apply");
    },
    ignore,
    controller.signal,
  );
  await settle();
  expect(subscribe).toHaveBeenCalledTimes(1);

  // The waits between resynchronisations double (250, 500, 1000) although the first event of each subscription applies.
  await vi.advanceTimersByTimeAsync(PUMP_RETRY_INITIAL_MS - 1);
  expect(subscribe).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(subscribe).toHaveBeenCalledTimes(SECOND_ATTEMPT);
  await vi.advanceTimersByTimeAsync(
    PUMP_RETRY_INITIAL_MS * PUMP_RETRY_FACTOR - 1,
  );
  expect(subscribe).toHaveBeenCalledTimes(SECOND_ATTEMPT);
  await vi.advanceTimersByTimeAsync(1);
  expect(subscribe).toHaveBeenCalledTimes(THIRD_ATTEMPT);
  await vi.advanceTimersByTimeAsync(
    PUMP_RETRY_INITIAL_MS * PUMP_RETRY_FACTOR ** SECOND_ATTEMPT - 1,
  );
  expect(subscribe).toHaveBeenCalledTimes(THIRD_ATTEMPT);

  controller.abort();
  await pumped;
});

it("starts the handler's backoff over after a run of events applied without a failure", async () => {
  const controller = new AbortController();
  let subscription = 0;
  const subscribe = vi.fn(async (): Promise<AsyncIterable<TestEvent>> => {
    subscription++;
    if (subscription >= SPIN_LIMIT) controller.abort();
    if (subscription === 1) return stream([{ n: 0 }], false);
    // A run long enough to count as recovered, then an event the handler cannot apply.
    return stream(
      [
        ...Array.from({ length: PUMP_HANDLER_RECOVERY_EVENTS }, (_, index) => ({
          n: index + 1,
        })),
        { n: -1 },
      ],
      false,
    );
  });

  const pumped = pumpEvents(
    subscribe,
    (event) => {
      if (event.n <= 0) throw new Error("cannot apply");
    },
    ignore,
    controller.signal,
  );
  await settle();
  // First failure waits the first step and doubles the handler's wait.
  await vi.advanceTimersByTimeAsync(PUMP_RETRY_INITIAL_MS);
  expect(subscribe).toHaveBeenCalledTimes(SECOND_ATTEMPT);
  // The run of applied events started it over, so the next failure waits the first step again, not the doubled one.
  await vi.advanceTimersByTimeAsync(PUMP_RETRY_INITIAL_MS);
  expect(subscribe).toHaveBeenCalledTimes(THIRD_ATTEMPT);

  controller.abort();
  await pumped;
});

it("forgets the id before reporting a handler failure, so a callback that throws cannot keep it", async () => {
  const resumedFrom: (string | undefined)[] = [];
  const controller = new AbortController();
  const subscribe = vi.fn(
    async (
      lastEventId: string | undefined,
    ): Promise<AsyncIterable<TestEvent>> => {
      resumedFrom.push(lastEventId);
      if (resumedFrom.length >= SECOND_ATTEMPT) controller.abort();
      return stream(
        [
          withEventMeta({ n: 1 }, { id: "a" }),
          withEventMeta({ n: SECOND_ATTEMPT }, { id: "b" }),
        ],
        false,
      );
    },
  );

  const pumped = pumpEvents(
    subscribe,
    (event) => {
      if (event.n === SECOND_ATTEMPT) throw new Error("cannot apply");
    },
    () => {
      throw new Error("the report failed too");
    },
    controller.signal,
  );
  await vi.advanceTimersByTimeAsync(PUMP_RETRY_INITIAL_MS);
  await pumped;

  expect(resumedFrom).toEqual([undefined, undefined]);
});

it("does not record the id of an event the handler failed on", async () => {
  const resumedFrom: (string | undefined)[] = [];
  let attempt = 0;
  const subscribe = vi.fn(
    async (
      lastEventId: string | undefined,
    ): Promise<AsyncIterable<TestEvent>> => {
      resumedFrom.push(lastEventId);
      attempt++;
      if (attempt === 1) {
        return stream([withEventMeta({ n: 1 }, { id: "a" })], true);
      }
      return stream([], false);
    },
  );

  const pumped = pumpEvents(
    subscribe,
    () => undefined,
    ignore,
    new AbortController().signal,
  );
  await vi.advanceTimersByTimeAsync(PUMP_RETRY_INITIAL_MS);
  await pumped;

  // An event applied and then a transport drop resumes from that event's id, in contrast to a handler failure above.
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

import type { Clock } from "wire-mesh-core/ports/clock";

/** A clock that only moves when a test advances it, so a bound stated in milliseconds is exercised without waiting. */
export interface ManualClock extends Clock {
  advance: (ms: number) => void;
}

export function manualClock(startMs = 0): ManualClock {
  let now = startMs;

  return {
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
  };
}

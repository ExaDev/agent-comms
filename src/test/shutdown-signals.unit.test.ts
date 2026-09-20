/**
 * The shared termination-signal handling every bridge installs (agent-comms#285). Exercised by emitting the signals on the real process object rather than by faking it, with process.exit and process.kill stubbed so the test run itself survives -- the point of the helper is what it does to a real process's signal handlers, which a fake would not observe.
 */

import { test, expect, vi, afterEach } from "vitest";
import { installShutdownSignalHandlers } from "../core/shutdown-signals.js";

const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

afterEach(() => {
  vi.restoreAllMocks();
});

/** Replaces the two ways the helper can end a process, returning what each recorded. process.exit is typed as never-returning, so the stub has to satisfy that signature without actually leaving. */
function captureProcessEnd(): {
  exits: number[];
  reraised: (string | number)[];
} {
  const exits: number[] = [];
  const reraised: (string | number)[] = [];
  vi.spyOn(process, "exit").mockImplementation(
    (code?: string | number | null): never => {
      exits.push(typeof code === "number" ? code : 0);
      // process.exit is declared as never-returning, and this stub deliberately does return -- the test run has to survive the signal it is exercising.
      return undefined as never;
    },
  );
  vi.spyOn(process, "kill").mockImplementation(
    (_pid: number, signal?: string | number): true => {
      reraised.push(signal ?? "none");
      return true;
    },
  );
  return { exits, reraised };
}

/** Lets the handler's own shutdown promise and its trailing finally settle before the assertions read what it recorded. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test("every termination signal runs the shutdown once", async () => {
  captureProcessEnd();
  const shutdowns: string[] = [];
  const remove = installShutdownSignalHandlers({
    shutdown: async () => {
      shutdowns.push("ran");
    },
    disposition: "exit",
  });

  for (const signal of SIGNALS) {
    process.emit(signal);
    await settle();
  }
  remove();

  expect(shutdowns).toHaveLength(SIGNALS.length);
});

test("a bridge that owns its process exits cleanly once the shutdown has run", async () => {
  const { exits, reraised } = captureProcessEnd();
  const order: string[] = [];
  const remove = installShutdownSignalHandlers({
    shutdown: async () => {
      order.push("shutdown");
    },
    disposition: "exit",
  });

  process.emit("SIGTERM");
  await settle();
  remove();

  expect(order).toEqual(["shutdown"]);
  expect(exits).toEqual([0]);
  expect(reraised).toEqual([]);
});

test("a bridge inside a host process re-raises the signal instead of exiting", async () => {
  const { exits, reraised } = captureProcessEnd();
  const remove = installShutdownSignalHandlers({
    shutdown: async () => {},
    disposition: "reraise",
  });

  process.emit("SIGINT");
  await settle();
  remove();

  expect(reraised).toEqual(["SIGINT"]);
  expect(exits).toEqual([]);
});

test("a shutdown that fails is reported and the process still ends", async () => {
  const { exits } = captureProcessEnd();
  const errors: Error[] = [];
  const remove = installShutdownSignalHandlers({
    shutdown: async () => {
      throw new Error("the mesh was already gone");
    },
    disposition: "exit",
    onError: (error) => {
      errors.push(error);
    },
  });

  process.emit("SIGHUP");
  await settle();
  remove();

  expect(errors.map((error) => error.message)).toEqual([
    "the mesh was already gone",
  ]);
  expect(exits).toEqual([0]);
});

test("removing the handlers leaves the process's own signal handling untouched", async () => {
  const { exits } = captureProcessEnd();
  const shutdowns: string[] = [];
  const remove = installShutdownSignalHandlers({
    shutdown: async () => {
      shutdowns.push("ran");
    },
    disposition: "exit",
  });

  remove();
  expect(process.listenerCount("SIGTERM")).toBe(0);
  await settle();

  expect(shutdowns).toEqual([]);
  expect(exits).toEqual([]);
});

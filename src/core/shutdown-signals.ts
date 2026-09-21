/**
 * The termination-signal handling every bridge needs, in one place. A bridge that exits without running MeshStore.shutdown() never hands its coordinator role on, so if it held that role the mesh is left with no coordinator until the surviving peers notice and race for the port -- recoverable, but it loses whatever the coordinator process alone was doing (the stale-agent probe and the cc-peer front) for as long as the race takes.
 *
 * Which signals a process should answer is not in question; what differs is what it may do afterwards. A bridge that owns its own process exits. A bridge loaded into someone else's process (a plugin) must not: registering any listener for SIGINT or SIGTERM removes Node's own default terminate behaviour, so a plugin that handled the signal and then did nothing would silently swallow its host's Ctrl-C. Such a bridge re-raises instead, which reaches the host's own handler if it has one and terminates the process as usual if it does not.
 */

/** The termination signals a bridge answers. SIGHUP matters as much as the other two here: a bridge started from a terminal that closes receives only SIGHUP, and without it that exit is silently ungraceful. */
const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

/** The exit status a bridge reports when it shut down in answer to a signal: this is an orderly exit that did exactly what it was asked to. */
const CLEAN_EXIT_CODE = 0;

/** What a bridge does once its shutdown has run. "exit" ends the process and suits a bridge that owns it. "reraise" re-sends the same signal with this handler removed, so a bridge loaded into a host process leaves the decision to the host rather than exiting on its behalf. */
export type ShutdownDisposition = "exit" | "reraise";

export interface ShutdownSignalOptions {
  /** The orderly shutdown itself, normally MeshStore.shutdown() plus whatever else the bridge owns. It is never expected to throw: a rejection here is reported to onError and the process still goes on to exit or re-raise. */
  shutdown: () => Promise<void>;
  /** See ShutdownDisposition. */
  disposition: ShutdownDisposition;
  /** Reports a shutdown that failed part way. Optional, since a bridge whose only sink is a protocol stream on stdout may have nowhere useful to write during its own exit. */
  onError?: ((error: Error) => void) | undefined;
}

/**
 * Installs one handler per termination signal, each running `shutdown` once and then exiting or re-raising per `disposition`. Registered with `once`, so a second signal of the same kind while the shutdown is still in flight takes the default action rather than starting a second one -- which is also what makes "reraise" terminate rather than loop.
 *
 * Returns a function that removes every handler it installed, for a caller that shuts down by some other route (a host's own lifecycle hook, or a test) and does not want the handlers outliving it.
 */
export function installShutdownSignalHandlers(
  options: Readonly<ShutdownSignalOptions>,
): () => void {
  const { shutdown, disposition, onError } = options;
  const installed = SHUTDOWN_SIGNALS.map((signal) => {
    const handler = (): void => {
      void shutdown()
        .catch((error: unknown) => {
          onError?.(error instanceof Error ? error : new Error(String(error)));
        })
        .finally(() => {
          if (disposition === "exit") {
            process.exit(CLEAN_EXIT_CODE);
            return;
          }
          process.kill(process.pid, signal);
        });
    };
    process.once(signal, handler);
    return { signal, handler };
  });

  return () => {
    for (const { signal, handler } of installed) {
      process.off(signal, handler);
    }
  };
}

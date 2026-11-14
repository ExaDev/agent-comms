/**
 * Work started and not awaited, which must never end the process by rejecting: a peer decides what its messages contain, so an exception while handling one is reported, not left as an unhandled rejection.
 */

/**
 * Attaches a rejection handler to `work`. A rejection goes to the error handler `getOnError` returns when it settles (read then, not now, so a handler assigned after the work started is the one used), and to stderr when there is none, so it is never silent.
 */
export function reportRejection(
  work: Readonly<Promise<unknown>>,
  getOnError: () => ((error: Error) => void) | undefined,
): void {
  work.catch((error: unknown) => {
    const failure = error instanceof Error ? error : new Error(String(error));
    const onError = getOnError();
    if (onError !== undefined) {
      onError(failure);
      return;
    }
    process.stderr.write(`agent-comms: ${failure.message}\n`);
  });
}

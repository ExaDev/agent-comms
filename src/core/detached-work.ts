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

function report(
  error: unknown,
  getOnError: () => ((error: Error) => void) | undefined,
): void {
  reportRejection(
    Promise.reject(error instanceof Error ? error : new Error(String(error))),
    getOnError,
  );
}

/**
 * Reads `items` until the stream ends, handing each to `handle` in arrival order, one at a time. A failure of `handle` is reported through `getOnError` (see reportRejection) and the loop carries on: one item a peer sent that cannot be handled must not stop every later one on the same session. A failure of the stream itself ends the loop and is reported the same way. Never rejects.
 */
export async function consumeEach<T>(
  items: Readonly<AsyncIterable<T>>,
  handle: (item: T) => Promise<void> | void,
  getOnError: () => ((error: Error) => void) | undefined,
): Promise<void> {
  try {
    for await (const item of items) {
      try {
        await handle(item);
      } catch (error) {
        report(error, getOnError);
      }
    }
  } catch (error) {
    report(error, getOnError);
  }
}

/**
 * ReceiverSet: the observers a MeshStore fans one of its events out to (agent-comms#293). A store has a single assignable callback per event (onDelivery, onPatch), so the bridge that owns the store and anything else serving from it, the web UI, would silence each other by assigning last. The callback keeps working, and a ReceiverSet adds any number of observers alongside it.
 */

/** A callback for an event whose payload is Args. */
export type Receiver<Args extends unknown[]> = (
  ...args: Args
) => void | Promise<void>;

export class ReceiverSet<Args extends unknown[]> {
  private readonly receivers = new Set<Receiver<Args>>();

  /** Adds an observer and returns a function that removes it. */
  add(receiver: Receiver<Args>): () => void {
    this.receivers.add(receiver);
    return () => {
      this.receivers.delete(receiver);
    };
  }

  /**
   * The single function to call for an event: the store's own assignable callback, when it has one, and then every observer, or undefined while there is neither, so a caller can still tell nobody is listening. A receiver that throws or rejects is passed to onError and does not stop the others.
   */
  handler(
    primary: Receiver<Args> | undefined,
    onError: (error: unknown) => void,
  ): ((...args: Args) => Promise<void>) | undefined {
    if (primary === undefined && this.receivers.size === 0) return undefined;
    return async (...args) => {
      const all = [
        ...(primary !== undefined ? [primary] : []),
        ...this.receivers,
      ];
      const outcomes = await Promise.allSettled(
        all.map(async (receive) => receive(...args)),
      );
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") onError(outcome.reason);
      }
    };
  }
}

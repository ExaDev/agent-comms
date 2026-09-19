/**
 * SharedPeer -- a lazily-created, process-wide holder of one cc-peer peer.
 *
 * cc-peer binds one socket per process (`<socket dir>/<pid>.sock`) and registers one session entry per pid, so a second CcPeer.create in the same process fails with EADDRINUSE. Every role in a process that talks through cc-peer (the default front, the one-shot `bridge cc-peer` command) therefore has to go through a single instance.
 */

/** Holds at most one peer of type P, created by the injected factory on first use. */
export class SharedPeer<P> {
  private promise: Promise<P> | undefined;

  constructor(private readonly create: () => Promise<P>) {}

  /** The shared peer, creating it on the first call. Concurrent callers share one creation. A failed creation is forgotten, so the next call retries rather than replaying the same rejection forever. */
  async get(): Promise<P> {
    this.promise ??= this.create().catch((error: unknown) => {
      this.promise = undefined;
      throw error;
    });
    return this.promise;
  }

  /** Forgets the shared peer and returns it so the caller can stop it, or undefined if none was ever successfully created. The next get() creates a fresh one. */
  async release(): Promise<P | undefined> {
    const pending = this.promise;
    this.promise = undefined;
    return pending?.catch(() => undefined);
  }
}

/**
 * retryOnAddrInUse — bind-retry backoff for WireMeshTransport.becomeCoordinator (agent-comms#170). Split out of wire-mesh-transport.ts to keep that file under the repo's max-lines cap, matching the same split-out-a-collaborator convention peer-lifecycle.ts and friends already use.
 */

/** Number of extra attempts becomeCoordinator makes after an initial EADDRINUSE before giving up. Covers PeerLifecycle's own graceful coordinator handover: the outgoing coordinator's listening socket may not have finished releasing the coordinator port yet when the successor's own become_coordinator handler tries to rebind it moments later. Retrying a plain server bind carries none of the risk documented elsewhere against retrying a TLS connectToCoordinator (a Node TLS session-cache bug that can freeze the event loop) -- this is ordinary bind-after-close backoff, the same class of transient conflict any two processes racing to acquire the same port would need to tolerate. */
export const BECOME_COORDINATOR_BIND_RETRIES = 5;
/** Delay between each becomeCoordinator bind retry -- five retries at this interval gives ~150ms of tolerance, comparable to the crash-race path's own documented "~100ms recovery". */
export const BECOME_COORDINATOR_BIND_RETRY_DELAY_MS = 30;

/** Retries `attempt` while it keeps rejecting with an EADDRINUSE-shaped error, up to `retries` further attempts, waiting `delayMs` between each. Any other error, or exhausting the retry budget, rethrows immediately -- never silently swallowed. A pure, transport-agnostic helper (no socket knowledge of its own) so becomeCoordinator's bind-retry race is fast and deterministic to test directly. */
export async function retryOnAddrInUse<T>(
  attempt: () => Promise<T>,
  retries: number,
  delayMs: number,
): Promise<T> {
  for (let tryNumber = 0; ; tryNumber++) {
    try {
      return await attempt();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("EADDRINUSE") || tryNumber >= retries) throw error;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
      });
    }
  }
}

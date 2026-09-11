/** Wires a real TlsTransport with a freshly generated identity onto a freshly constructed MeshStore -- the same setTransport() call every production bridge makes immediately after construction. MeshStore has no default transport, so every test that constructs one needs this (or an equivalent explicit setTransport() call) before init() or any other transport-using method runs. */

import { TlsTransport } from "../core/tls-transport.js";
import { generateIdentity } from "../core/identity.js";
import type { MeshStore } from "../core/mesh-store.js";

export function wireTestTransport(store: MeshStore): void {
  const identity = generateIdentity();
  // Every real bridge sets peerId to the identity's own certificate fingerprint before wiring the transport -- TlsTransport's cert-pinning trust model means a peer's advertised ID and the fingerprint the other side actually authenticates the connection against must be the same value, or introduction/state-sync never recognises the peer as itself.
  store.peerId = identity.fingerprint;
  store.setTransport(new TlsTransport(store.events, identity));
}

// Generous on purpose: waitFor returns the instant its condition holds, so a long ceiling costs nothing on the happy path (a local run settles in well under a second) and only matters for the worst case -- a loaded CI runner working through a real, sequential chain of TLS handshakes (each one genuine X.509 certificate work, not instant) for the accept-flow's second connection direction, confirmed to need meaningfully more than 5s on at least one real CI run.
const DEFAULT_WAIT_FOR_TIMEOUT_MS = 20_000;
const WAIT_FOR_POLL_INTERVAL_MS = 20;

/**
 * Polls condition() until it returns true or timeoutMs elapses, rather than a fixed sleep() before a single check. A real TLS handshake plus the peer_list -> connectToPeer -> state_sync -> handlePeerConnected round trip genuinely takes variable, load-dependent wall-clock time -- comfortably inside a fixed sleep on a fast local machine, not reliably so under a throttled CI runner. Throws with a descriptive message on timeout rather than letting the caller's own assertion fail with a less specific one.
 */
export async function waitFor(
  condition: () => boolean,
  description: string,
  timeoutMs = DEFAULT_WAIT_FOR_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(
        `waitFor timed out after ${String(timeoutMs)}ms: ${description}`,
      );
    }
    await new Promise((resolve) =>
      setTimeout(resolve, WAIT_FOR_POLL_INTERVAL_MS),
    );
  }
}

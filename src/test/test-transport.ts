/** Wires a real WireMeshTransport plus a persisted identity slot onto a freshly constructed MeshStore -- the same setTransport()/setIdentity() calls every production bridge makes immediately after construction (via createBridgeMesh). MeshStore has no default transport or identity, so every test that constructs one needs this (or an equivalent explicit wiring) before init(), createRoom(), or any other transport- or identity-using method runs. */

import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { WireMeshTransport } from "../core/wire-mesh-transport.js";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { createSystemClock } from "wire-mesh-core/adapters/system-clock";
import { createRevocationView } from "wire-mesh-core/domain/revocation-view";
import { loadOrCreateIdentity } from "../core/identity-store.js";
import type { IdentitySlot } from "../core/identity-store.js";
import { toIdentityPort } from "../core/wire-mesh-identity.js";
import { nanoid } from "../core/nanoid.js";
import type { MeshStore } from "../core/mesh-store.js";

/** Wires store onto a fresh WireMeshTransport and a persisted identity slot, returning the slot so a test can inspect (or reuse) the persisted room tokens directly via loadRoomTokens(). Defaults to a throwaway temp-dir slot per call -- pass an explicit slot when a test needs the same identity to survive across more than one wireTestTransport call (e.g. simulating a restart). */
export async function wireTestTransport(
  store: MeshStore,
  slot?: Readonly<IdentitySlot>,
): Promise<IdentitySlot> {
  const resolvedSlot: IdentitySlot = slot ?? {
    harness: "test",
    cwd: nanoid(8),
    dir: fs.mkdtempSync(path.join(tmpdir(), "agent-comms-test-identity-")),
  };
  const identity = loadOrCreateIdentity(resolvedSlot);
  // Every real bridge sets peerId to deviceIdToHex(identity.deviceId) before wiring the transport (createBridgeMesh) -- WireMeshTransport's own session bookkeeping is keyed by device-id, so a peer's advertised ID and the identity the other side actually authenticates the connection against must be the same value, or introduction/state-sync never recognises the peer as itself.
  store.peerId = deviceIdToHex(Uint8Array.from(identity.deviceId));
  store.setTransport(
    new WireMeshTransport(store.events, identity, store.roomVerbHandlers),
  );
  store.setIdentity({
    identity: await toIdentityPort(identity),
    clock: createSystemClock(),
    slot: resolvedSlot,
    revocation: createRevocationView(),
  });
  // Surface transport-level errors instead of leaving them silent — a genuine socket failure during a test run is signal worth seeing even when the test's own assertions still pass, since it can point at a real race the assertions don't happen to catch.
  store.onError = (e) => {
    console.error(`[transport error, peerId=${store.peerId}]`, e.message);
  };
  return resolvedSlot;
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

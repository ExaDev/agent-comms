/**
 * Shared bootstrap for a bridge's own mesh participation: load or create this bridge's persisted identity, construct a MeshStore wired to WireMeshTransport, and build the CommsTool that sits on top of it. Every bridge previously repeated this same four-line block against TlsTransport/identity.fingerprint directly; this factory is the single place that wiring lives now, so the substrate a bridge runs on is a one-line change here rather than six repeated ones.
 *
 * peerId is deviceIdToHex(identity.deviceId), not identity.fingerprint -- WireMeshTransport's own session bookkeeping is keyed by device-id, so MeshStore's own notion of "this peer's id" has to be the same value for the two to correlate. Every existing agent id changes the first time a bridge starts through this factory: there is no migration path, since the value is a hash of genuinely different bytes (device-id is SHA-256(raw public key); fingerprint is SHA-256(certificate DER)) -- a hard cutover, already established as correct when identity.ts first grew deviceId, not relitigated here.
 */

import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { MeshStore } from "./mesh-store.js";
import { CommsTool } from "./tool.js";
import { WireMeshTransport } from "./wire-mesh-transport.js";
import { loadOrCreateIdentity } from "./identity-store.js";
import type { IdentitySlot } from "./identity-store.js";

export interface BridgeMesh {
  store: MeshStore;
  tool: CommsTool;
}

export function createBridgeMesh(
  slot: Readonly<IdentitySlot>,
  coordinatorPort?: number,
): BridgeMesh {
  const identity = loadOrCreateIdentity(slot);
  const store = new MeshStore(coordinatorPort);
  store.peerId = deviceIdToHex(Uint8Array.from(identity.deviceId));
  store.setTransport(new WireMeshTransport(store.events, identity));
  const tool = new CommsTool(store, store.discovery);
  return { store, tool };
}

/**
 * Shared bootstrap for a bridge's own mesh participation: load or create this bridge's persisted identity, construct a MeshStore wired to WireMeshTransport, and build the CommsTool that sits on top of it. Every bridge previously repeated this same four-line block against TlsTransport/identity.fingerprint directly; this factory is the single place that wiring lives now, so the substrate a bridge runs on is a one-line change here rather than six repeated ones.
 *
 * peerId is deviceIdToHex(identity.deviceId), not identity.fingerprint -- WireMeshTransport's own session bookkeeping is keyed by device-id, so MeshStore's own notion of "this peer's id" has to be the same value for the two to correlate. Every existing agent id changes the first time a bridge starts through this factory: there is no migration path, since the value is a hash of genuinely different bytes (device-id is SHA-256(raw public key); fingerprint is SHA-256(certificate DER)) -- a hard cutover, already established as correct when identity.ts first grew deviceId, not relitigated here.
 *
 * Split into a synchronous half (wireBridgeMesh) and an async half (attachMintingIdentity, wrapping toIdentityPort's WebCrypto import) because deriving the IdentityPort MeshStore mints room-membership grants against is unavoidably async, but not every bridge entry point can await one inline -- a plugin loader that calls its extension's default export synchronously (e.g. pi's own) cannot. createBridgeMeshSync exposes both halves for that case, deferring attachIdentity() to wherever the bridge's own lifecycle first has an async context (its own session-start hook), which is always well before the bridge does anything identity-dependent like createRoom. createBridgeMesh remains the convenient all-in-one for every bridge whose own entry point is already async.
 *
 * Also starts this bridge's own VersionDriftChecker (agent-comms#166) and wires its result into the CommsTool it builds, so every real bridge gets npm release-drift reporting on whoami/update for free from this one construction point, with no per-bridge wiring. fetchLatestVersion is exposed purely for tests -- every real caller omits it and gets VersionDriftChecker's own default (a real npm registry lookup); a test that would otherwise trigger real network I/O on every createBridgeMesh call injects a fake resolver instead.
 */

import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { createSystemClock } from "wire-mesh-core/adapters/system-clock";
import { createRevocationView } from "wire-mesh-core/domain/revocation-view";
import { createNodeFsStorage } from "wire-mesh-core/adapters/node-fs-storage";
import { MeshStore } from "./mesh-store.js";
import { CommsTool } from "./tool.js";
import { WireMeshTransport } from "./wire-mesh-transport.js";
import { loadOrCreateIdentity, oplogDirFor } from "./identity-store.js";
import type { IdentitySlot } from "./identity-store.js";
import { toIdentityPort } from "./wire-mesh-identity.js";
import { VersionDriftChecker } from "./version-check.js";
import { getOwnPackageVersion } from "./package-version.js";

export interface BridgeMesh {
  store: MeshStore;
  tool: CommsTool;
}

export interface BridgeMeshSync extends BridgeMesh {
  /** Derives and wires this store's IdentityPort (the collaborator createRoom and every other identity-using method require). Must be awaited before any such method runs; safe to call from the bridge's own first async lifecycle hook rather than its (necessarily synchronous) entry point. */
  attachIdentity: () => Promise<void>;
}

/** The synchronous half of bridge construction: everything loadOrCreateIdentity's own synchronous key material makes possible. Use this directly only when the calling entry point cannot await inline (see this file's own header comment); every other caller should use createBridgeMesh below. */
export function createBridgeMeshSync(
  slot: Readonly<IdentitySlot>,
  coordinatorPort?: number,
  hubUrl?: string,
  fetchLatestVersion?: () => Promise<string | undefined>,
): BridgeMeshSync {
  const identity = loadOrCreateIdentity(slot);
  const store = new MeshStore(coordinatorPort, hubUrl);
  store.peerId = deviceIdToHex(Uint8Array.from(identity.deviceId));
  // One shared dataStorage instance for both the transport's own data-domain frame responder and the store's own durable-send mint path (P5, agent-comms#50) -- oplogDirFor(slot) needs only the slot, not the async identity below, so this can be constructed synchronously right here.
  const dataStorage = createNodeFsStorage({ dir: oplogDirFor(slot) });
  store.setTransport(
    new WireMeshTransport(
      store.events,
      identity,
      store.roomVerbHandlers,
      undefined,
      () => store.selfStatus,
      undefined,
      () => store.hostedRooms,
      dataStorage,
      () => store.selfAgentAdvert,
    ),
  );
  const versionChecker = new VersionDriftChecker({
    currentVersion: getOwnPackageVersion(),
    ...(fetchLatestVersion !== undefined ? { fetchLatestVersion } : {}),
  });
  versionChecker.start();
  const tool = new CommsTool(store, store.discovery, () =>
    versionChecker.getNewerVersionIfAny(),
  );
  const revocation = createRevocationView();
  return {
    store,
    tool,
    attachIdentity: async () => {
      store.setIdentity({
        identity: await toIdentityPort(identity),
        clock: createSystemClock(),
        slot,
        revocation,
        dataStorage,
      });
    },
  };
}

export async function createBridgeMesh(
  slot: Readonly<IdentitySlot>,
  coordinatorPort?: number,
  hubUrl?: string,
  fetchLatestVersion?: () => Promise<string | undefined>,
): Promise<BridgeMesh> {
  const { store, tool, attachIdentity } = createBridgeMeshSync(
    slot,
    coordinatorPort,
    hubUrl,
    fetchLatestVersion,
  );
  await attachIdentity();
  return { store, tool };
}

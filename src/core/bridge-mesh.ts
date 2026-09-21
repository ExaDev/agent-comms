/**
 * Shared bootstrap for a bridge's own mesh participation: load or create this bridge's persisted identity, construct a MeshStore wired to WireMeshTransport, and build the CommsTool that sits on top of it. Every bridge previously repeated this same four-line block against TlsTransport/identity.fingerprint directly; this factory is the single place that wiring lives now, so the substrate a bridge runs on is a one-line change here rather than six repeated ones.
 *
 * peerId is deviceIdToHex(identity.deviceId), not identity.fingerprint -- WireMeshTransport's own session bookkeeping is keyed by device-id, so MeshStore's own notion of "this peer's id" has to be the same value for the two to correlate. Every existing agent id changes the first time a bridge starts through this factory: there is no migration path, since the value is a hash of genuinely different bytes (device-id is SHA-256(raw public key); fingerprint is SHA-256(certificate DER)) -- a hard cutover, already established as correct when identity.ts first grew deviceId, not relitigated here.
 *
 * Split into a synchronous half (wireBridgeMesh) and an async half (attachMintingIdentity, wrapping toIdentityPort's WebCrypto import) because deriving the IdentityPort MeshStore mints room-membership grants against is unavoidably async, but not every bridge entry point can await one inline -- a plugin loader that calls its extension's default export synchronously (e.g. pi's own) cannot. createBridgeMeshSync exposes both halves for that case, deferring attachIdentity() to wherever the bridge's own lifecycle first has an async context (its own session-start hook), which is always well before the bridge does anything identity-dependent like createRoom. createBridgeMesh remains the convenient all-in-one for every bridge whose own entry point is already async.
 *
 * Also starts this bridge's own VersionDriftChecker (agent-comms#166) and wires its result into the CommsTool it builds, so every real bridge gets npm release-drift reporting on whoami/update for free from this one construction point, with no per-bridge wiring. fetchLatestVersion is exposed purely for tests -- every real caller omits it and gets VersionDriftChecker's own default (a real npm registry lookup); a test that would otherwise trigger real network I/O on every createBridgeMesh call injects a fake resolver instead.
 *
 * createBridgeMeshSync/createBridgeMesh own loadOrCreateIdentity's slot lock on the caller's behalf; createBridgeMeshSyncFromIdentity/createBridgeMeshFromIdentity take an already-loaded identity instead and never touch the lock at all -- the cc-peer front (agent-comms#157) uses these directly, via loadIdentityForFront's lock-free load, to build a mesh identity for a not-yet-live session's slot while leaving that slot's own lock free for its real bridge to acquire normally later.
 *
 * Passes slot through to MeshStore's own constructor (agent-comms#186) so the gatewayTrust allowlist it builds loads whatever remote device-ids were trusted before the last restart, and persists every subsequent addTrustedGateway/removeTrustedGateway back to the identity directory's one shared trust file, which every other store on the machine reads as well (agent-comms#293). The same slot backs MeshStore's connectionCodes ledger (agent-comms#188), which stays per slot.
 *
 * The returned store's own getCcPeerVersion field starts undefined and is read live (never snapshotted) by both WireMeshTransport's gossip tick and CommsTool's whoami/update/list_agents -- front-runtime.ts and bridges/cc-peer/run.ts set it once, right after this factory returns, rather than this factory taking it as a parameter: only those two call sites ever have a value for it, so threading it through every createBridgeMesh* signature here would be dead weight on every other caller (agent-comms#198).
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
import type { PeerIdentity } from "./identity.js";
import { VersionDriftChecker } from "./version-check.js";
import { getOwnPackageVersion } from "./package-version.js";
import { loadOrCreateUserIdentity } from "./user-identity.js";

export interface BridgeMesh {
  store: MeshStore;
  tool: CommsTool;
}

export interface BridgeMeshSync extends BridgeMesh {
  /** Derives and wires this store's IdentityPort (the collaborator createRoom and every other identity-using method require). Must be awaited before any such method runs; safe to call from the bridge's own first async lifecycle hook rather than its (necessarily synchronous) entry point. */
  attachIdentity: () => Promise<void>;
}

/** coordinatorPort/hubUrl thread straight into MeshStore's own constructor; fetchLatestVersion is exposed purely for tests -- every real caller omits it and gets VersionDriftChecker's own default (a real npm registry lookup). */
export interface BridgeMeshOptions {
  coordinatorPort?: number | undefined;
  hubUrl?: string | undefined;
  fetchLatestVersion?: (() => Promise<string | undefined>) | undefined;
}

/** The synchronous half of bridge construction: everything loadOrCreateIdentity's own synchronous key material makes possible. Use this directly only when the calling entry point cannot await inline (see this file's own header comment); every other caller should use createBridgeMesh below. */
export function createBridgeMeshSync(
  slot: Readonly<IdentitySlot>,
  options?: BridgeMeshOptions,
): BridgeMeshSync {
  return createBridgeMeshSyncFromIdentity(
    loadOrCreateIdentity(slot),
    slot,
    options,
  );
}

/**
 * The same synchronous construction as createBridgeMeshSync, but taking an already-loaded identity rather than calling loadOrCreateIdentity itself -- see this file's own header comment for who this is for. Every other caller should go through createBridgeMeshSync/createBridgeMesh above, which own the lock on the caller's behalf.
 */
export function createBridgeMeshSyncFromIdentity(
  identity: PeerIdentity,
  slot: Readonly<IdentitySlot>,
  options?: BridgeMeshOptions,
): BridgeMeshSync {
  const { coordinatorPort, hubUrl, fetchLatestVersion } = options ?? {};
  // The user-principal identity (agent-comms#160) is shared by every bridge on this machine account -- deliberately not scoped to slot, unlike identity above. userIdentityOptions is empty (the default ~/.agent-comms location); every real bridge shares it, and only tests need an override.
  const userIdentityOptions = {};
  const userIdentity = loadOrCreateUserIdentity(userIdentityOptions);
  const store = new MeshStore({ coordinatorPort, hubUrl, slot });
  store.peerId = deviceIdToHex(Uint8Array.from(identity.deviceId));
  // One shared dataStorage instance for both the transport's own data-domain frame responder and the store's own durable-send mint path (P5, agent-comms#50) -- oplogDirFor(slot) needs only the slot, not the async identity below, so this can be constructed synchronously right here.
  const dataStorage = createNodeFsStorage({ dir: oplogDirFor(slot) });
  const transport = new WireMeshTransport(store.events, identity, {
    roomVerbHandlers: store.roomVerbHandlers,
    roomJoinApprovalTimeoutMs: store.roomJoinApprovalTimeoutMs,
    verifyMembership: async (claim) => store.membership.verify(claim),
    getCurrentPresence: () => store.selfStatus,
    getHostedRooms: () => store.hostedRooms,
    dataStorage,
    getSelfAgentAdvert: () => store.selfAgentAdvert,
    gatewayTrust: store.gatewayTrust,
  });
  transport.getCcPeerVersion = () => store.getCcPeerVersion?.();
  store.setTransport(transport);
  const versionChecker = new VersionDriftChecker({
    currentVersion: getOwnPackageVersion(),
    ...(fetchLatestVersion !== undefined ? { fetchLatestVersion } : {}),
  });
  versionChecker.start();
  const tool = new CommsTool(store, {
    discovery: store.discovery,
    getNewerVersionIfAny: () => versionChecker.getNewerVersionIfAny(),
  });
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
        userIdentity: await toIdentityPort(userIdentity),
        userIdentityOptions,
      });
    },
  };
}

export async function createBridgeMesh(
  slot: Readonly<IdentitySlot>,
  options?: BridgeMeshOptions,
): Promise<BridgeMesh> {
  const { store, tool, attachIdentity } = createBridgeMeshSync(slot, options);
  await attachIdentity();
  return { store, tool };
}

/** The async, already-loaded-identity counterpart to createBridgeMesh, mirroring createBridgeMeshSyncFromIdentity's relationship to createBridgeMeshSync. */
export async function createBridgeMeshFromIdentity(
  identity: PeerIdentity,
  slot: Readonly<IdentitySlot>,
  options?: BridgeMeshOptions,
): Promise<BridgeMesh> {
  const { store, tool, attachIdentity } = createBridgeMeshSyncFromIdentity(
    identity,
    slot,
    options,
  );
  await attachIdentity();
  return { store, tool };
}

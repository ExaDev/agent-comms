/**
 * Real cc-peer/MeshStore construction for the default coordinator-run front (agent-comms#157) -- the counterpart to bridges/cc-peer/run.ts's own real CcPeer.create()/createBridgeMesh construction for the one-shot `bridge cc-peer` command. Wires front-controller.ts's CcPeerFront (attach/detach diffing across ticks) to front-relay.ts's buildFrontedSessionRecord/detachFrontedSession (one session's own relay) against one shared, front-wide CcPeer instance and a fresh per-session MeshStore built from loadIdentityForFront's lock-free identity.
 *
 * Untested directly, exactly like run.ts's own real construction (see cc-peer-bridge.test.ts's header comment): front.ts, front-controller.ts, and front-relay.ts already carry the front's entire decision/diffing/relay logic under direct DI-based unit tests, so this file's only remaining job -- calling the real cc-peer/core APIs in the right order -- is exercised by actually running a bridge as this machine's coordinator.
 */

import { CcPeer, CC_PEER_VERSION } from "cc-peer";
import { AliasPool } from "cc-peer/alias-pool";
import type { AliasMessage } from "cc-peer/alias-pool";
import {
  createBridgeMeshFromIdentity,
  ensureRegistered,
  ensureProjectRoom,
} from "../../core/index.js";
import {
  loadIdentityForFront,
  probeSlotOwner,
} from "../../core/identity-store.js";
import { CcPeerFront } from "./front-controller.js";
import { computeFrontSlot } from "./front.js";
import type { CcPeerRosterEntryLike } from "./front.js";
import type { CcPeerInboundMessage } from "./bridge.js";
import {
  buildFrontedSessionRecord,
  detachFrontedSession,
  type FrontedRelayRecord,
  type FrontRelayPeer,
} from "./front-relay.js";
import { ReplyAliasDirectory } from "./reply-aliases.js";
import { SharedPeer } from "./shared-peer.js";

/** cc-peer's own registered display name for the front's shared peer -- distinct from any individual fronted session's own agent-comms display name (front-relay.ts's ensureRegistered call uses the session's own cc-peer name/pid for that). */
const FRONT_PEER_NAME = "agent-comms-front";

/** The slice of a cc-peer peer the front uses: reading the local roster, receiving messages, and sending to a fronted session. The real CcPeer satisfies it. */
export interface FrontCcPeer extends FrontRelayPeer {
  roster: () => Promise<readonly CcPeerRosterEntryLike[]>;
  on: (
    event: "message",
    listener: (message: Readonly<CcPeerInboundMessage>) => void,
  ) => unknown;
  stop: () => Promise<void>;
}

export interface CreateDefaultCcPeerFrontOptions {
  coordinatorPort?: number | undefined;
  hubUrl?: string | undefined;
  pollIntervalMs?: number | undefined;
  onError?: ((error: Error) => void) | undefined;
  /** The cc-peer peer this process already owns, when it has one. cc-peer allows one peer per process, so a process that runs its own (the one-shot `bridge cc-peer` command) must lend it here rather than let the front try to create a second. The front only borrows it: it never stops it, and registers its inbound listener on it once. Without this the front creates and owns its own peer. */
  peer?: FrontCcPeer | undefined;
  /** The name the shared peer is registered under, which fronted sessions are told to message to answer a join request. Defaults to the front's own peer name; a host process that lends its own peer names it here. */
  peerName?: string | undefined;
  /** Sessions this process already relays by other means, which the front must therefore leave alone. */
  excludeSession?:
    ((entry: Readonly<CcPeerRosterEntryLike>) => boolean) | undefined;
}

/** Falls back to "claude-code-<pid>" when a session has never picked its own cc-peer display name -- ensureRegistered requires a defaultName, and an unnamed session is still worth fronting under something stable and identifiable. */
function defaultSessionName(entry: Readonly<CcPeerRosterEntryLike>): string {
  return entry.name ?? `claude-code-${String(entry.pid)}`;
}

/**
 * Builds the default cc-peer front. start()/stop() are safe to call from bridge-mesh.ts's onCoordinatorRoleChanged hook regardless of whether cc-peer itself is usable on this machine: the shared CcPeer instance is created lazily, on the first poll tick that actually needs it (listRoster), not at start() itself, and any construction or attach failure is reported via onError rather than thrown -- "absent sockets" (no local Claude Code sessions at all) is then a clean no-op front rather than a crash of the coordinator that owns it.
 */
export function createDefaultCcPeerFront(
  options: Readonly<CreateDefaultCcPeerFrontOptions> = {},
): Pick<CcPeerFront<FrontedRelayRecord>, "start" | "stop"> {
  const borrowedPeer = options.peer;
  const peerName = options.peerName ?? FRONT_PEER_NAME;
  let aliasPool: AliasPool | undefined;
  const aliasDirectory = new ReplyAliasDirectory();

  const front = new CcPeerFront<FrontedRelayRecord>({
    listRoster: async () => {
      const peer = await ensureSharedPeer();
      return peer.roster();
    },
    probeSlotOwner,
    attach: async (entry) => attachSession(entry, await ensureSharedPeer()),
    detach: detachFrontedSession,
    aliasDirectory,
    excludeSession: options.excludeSession,
    pollIntervalMs: options.pollIntervalMs,
    onError: options.onError,
  });

  const sharedPeer = new SharedPeer<FrontCcPeer>(async () => {
    if (borrowedPeer !== undefined) return borrowedPeer;
    const peer = await CcPeer.create({ name: FRONT_PEER_NAME });
    peer.on("message", (message: Readonly<CcPeerInboundMessage>) => {
      front.handleInboundMessage(message);
    });
    return peer;
  });
  // A borrowed peer outlives the front's own start/stop cycles, so its listener is attached once here rather than on every (re)creation, which would relay each inbound message once per restart.
  borrowedPeer?.on("message", (message: Readonly<CcPeerInboundMessage>) => {
    front.handleInboundMessage(message);
  });

  return {
    start: () => {
      front.start();
    },
    stop: async () => {
      await front.stop();
      const peer = await sharedPeer.release();
      if (borrowedPeer === undefined) await peer?.stop();
      await aliasPool?.stopAll();
      aliasPool = undefined;
    },
  };

  /** Materialises the front's own shared AliasPool on first use (mirroring ensureSharedPeer's own lazy-construction convention) and wires its "message" event -- every reply arriving on any fronted session's own correspondent aliases -- straight into the controller's handleAliasMessage, which resolves the sending session and the alias's own correspondent before routing it on. */
  function ensureAliasPool(): AliasPool {
    if (aliasPool) return aliasPool;
    const pool = AliasPool.create();
    pool.on("message", (message: Readonly<AliasMessage>) => {
      front.handleAliasMessage(message);
    });
    aliasPool = pool;
    return pool;
  }

  async function ensureSharedPeer(): Promise<FrontCcPeer> {
    return sharedPeer.get();
  }

  async function attachSession(
    entry: Readonly<CcPeerRosterEntryLike>,
    peer: Readonly<FrontCcPeer>,
  ): Promise<FrontedRelayRecord> {
    const slot = computeFrontSlot(entry.cwd);
    const identity = loadIdentityForFront(slot);
    const { store, tool } = await createBridgeMeshFromIdentity(identity, slot, {
      coordinatorPort: options.coordinatorPort,
      hubUrl: options.hubUrl,
    });
    store.getCcPeerVersion = () => CC_PEER_VERSION;

    const reg = await ensureRegistered({
      store,
      harness: "claude-code",
      cwd: entry.cwd,
      defaultName: defaultSessionName(entry),
      visibility: "visible",
    });
    const roomId = await ensureProjectRoom(store, reg.agentId, entry.cwd);

    return buildFrontedSessionRecord({
      entry,
      peerName,
      agentId: reg.agentId,
      roomId,
      store,
      tool,
      peer,
      aliasPool: ensureAliasPool(),
      aliasDirectory,
    });
  }
}

/**
 * Real cc-peer/MeshStore construction for the default coordinator-run front (agent-comms#157) -- the counterpart to bridges/cc-peer/run.ts's own real CcPeer.create()/createBridgeMesh construction for the one-shot `bridge cc-peer` command. Wires front-controller.ts's CcPeerFront (attach/detach diffing across ticks) to front-relay.ts's buildFrontedSessionRecord/detachFrontedSession (one session's own relay) against one shared, front-wide CcPeer instance and a fresh per-session MeshStore built from loadIdentityForFront's lock-free identity.
 *
 * Untested directly, exactly like run.ts's own real construction (see cc-peer-bridge.test.ts's header comment): front.ts, front-controller.ts, and front-relay.ts already carry the front's entire decision/diffing/relay logic under direct DI-based unit tests, so this file's only remaining job -- calling the real cc-peer/core APIs in the right order -- is exercised by actually running a bridge as this machine's coordinator.
 */

import { CcPeer } from "cc-peer";
import type { InboundMessage as CcPeerInboundMessage } from "cc-peer";
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
import {
  buildFrontedSessionRecord,
  detachFrontedSession,
  type FrontedRelayRecord,
} from "./front-relay.js";

/** cc-peer's own registered display name for the front's shared peer -- distinct from any individual fronted session's own agent-comms display name (front-relay.ts's ensureRegistered call uses the session's own cc-peer name/pid for that). */
const FRONT_PEER_NAME = "agent-comms-front";

export interface CreateDefaultCcPeerFrontOptions {
  coordinatorPort?: number | undefined;
  hubUrl?: string | undefined;
  pollIntervalMs?: number | undefined;
  onError?: ((error: Error) => void) | undefined;
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
  let sharedPeerPromise: Promise<CcPeer> | undefined;

  const front = new CcPeerFront<FrontedRelayRecord>({
    listRoster: async () => {
      const peer = await ensureSharedPeer();
      return peer.roster();
    },
    probeSlotOwner,
    attach: async (entry) => attachSession(entry, await ensureSharedPeer()),
    detach: detachFrontedSession,
    pollIntervalMs: options.pollIntervalMs,
    onError: options.onError,
  });

  return {
    start: () => {
      front.start();
    },
    stop: async () => {
      await front.stop();
      const peer = await sharedPeerPromise?.catch(() => undefined);
      sharedPeerPromise = undefined;
      await peer?.stop();
    },
  };

  async function ensureSharedPeer(): Promise<CcPeer> {
    sharedPeerPromise ??= CcPeer.create({ name: FRONT_PEER_NAME }).then(
      (peer) => {
        peer.on("message", (message: Readonly<CcPeerInboundMessage>) => {
          front.handleInboundMessage(message);
        });
        return peer;
      },
    );
    return sharedPeerPromise;
  }

  async function attachSession(
    entry: Readonly<CcPeerRosterEntryLike>,
    peer: CcPeer,
  ): Promise<FrontedRelayRecord> {
    const slot = computeFrontSlot(entry.cwd);
    const identity = loadIdentityForFront(slot);
    const { store, tool } = await createBridgeMeshFromIdentity(
      identity,
      slot,
      options.coordinatorPort,
      options.hubUrl,
    );

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
      agentId: reg.agentId,
      roomId,
      store,
      tool,
      peer,
    });
  }
}

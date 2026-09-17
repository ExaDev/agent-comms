/**
 * Wires the default cc-peer front (agent-comms#157) onto a real bridge's own store, right after construction -- the piece that actually makes "a machine's coordinator bridge fronts local Claude Code sessions by default" true, rather than a capability every bridge builds but nothing ever switches on. Every real bridge entry point (pi, claude-code, mcp, codex, opencode, user, cc-peer's own one-shot command) calls this once, immediately after createBridgeMesh/createBridgeMeshSync.
 *
 * Deliberately the only file outside bridges/cc-peer/ that ever needs to know cc-peer exists: core/mesh-store.ts's onCoordinatorRoleChanged hook is generic (a bare boolean callback), and core/bridge-mesh.ts's factories return a plain MeshStore with no cc-peer awareness at all -- keeping this Node/filesystem/cc-peer-specific capability out of the transport-agnostic core, per this repo's own portable-runtime-boundary convention. A bridge that never becomes this machine's coordinator never starts a front at all; one that does gets it started and stopped automatically as that role comes and goes.
 */

import type { MeshStore } from "../../core/mesh-store.js";
import {
  createDefaultCcPeerFront,
  type CreateDefaultCcPeerFrontOptions,
} from "./front-runtime.js";
import type { CcPeerFront } from "./front-controller.js";
import type { FrontedSessionRecord } from "./front-controller.js";

export interface WireDefaultCcPeerFrontOptions {
  coordinatorPort?: number | undefined;
  hubUrl?: string | undefined;
  /** Builds the front itself -- defaults to the real createDefaultCcPeerFront. Overridable so this function's own start/stop wiring against store.onCoordinatorRoleChanged is testable without a real CcPeer/local Claude Code session. */
  createFront?:
    | ((
        options: Readonly<CreateDefaultCcPeerFrontOptions>,
      ) => Pick<CcPeerFront<FrontedSessionRecord>, "start" | "stop">)
    | undefined;
}

/**
 * Builds the store.onCoordinatorRoleChanged callback for a real bridge's own store. Returns the callback rather than assigning it directly, so the caller does the actual store.onCoordinatorRoleChanged = ... assignment itself -- this keeps the store parameter here read-only, matching every other pure-construction function in this file's neighbourhood, instead of this function reaching into the store to mutate it.
 */
export function wireDefaultCcPeerFront(
  store: Readonly<Pick<MeshStore, "onError">>,
  options: Readonly<WireDefaultCcPeerFrontOptions> = {},
): (isCoordinator: boolean) => Promise<void> {
  const createFront = options.createFront ?? createDefaultCcPeerFront;
  const front = createFront({
    coordinatorPort: options.coordinatorPort,
    hubUrl: options.hubUrl,
    onError: (error) => {
      store.onError?.(error);
    },
  });

  return async (isCoordinator: boolean) => {
    if (isCoordinator) {
      front.start();
    } else {
      await front.stop();
    }
  };
}

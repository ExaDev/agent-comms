/**
 * cc-peer bridge — CLI entry point.
 *
 * Run via: npx agent-comms bridge cc-peer <target-name> npx agent-comms bridge cc-peer --pid=<pid>
 *
 * Constructs the real CcPeer and MeshStore, then hands both to wireCcPeerBridge for the actual relay wiring (see bridge.ts).
 */

import { CcPeer, CC_PEER_VERSION } from "cc-peer";
import {
  createBridgeMesh,
  createMeshErrorReporter,
  ensureRegistered,
  ensureProjectRoom,
} from "../../core/index.js";
import type { IdentitySlot } from "../../core/identity-store.js";
import { releaseIdentityLock } from "../../core/identity-store.js";
import {
  createTargetSenderMatcher,
  targetMatchesEntry,
  wireCcPeerBridge,
  type CcPeerRef,
} from "./bridge.js";
import { wireDefaultCcPeerFront } from "./default-front.js";

const PID_FLAG_PREFIX = "--pid=";
/** argv layout for `node cli.js bridge cc-peer <target-arg>`: index 0/1 are the node binary and script path, 2 is "bridge", 3 is the bridge id ("cc-peer") itself -- this bridge's own args start one past that. */
const BRIDGE_ARGS_START_INDEX = 4;

function parseTarget(argv: readonly string[]): CcPeerRef {
  const arg = argv[0];
  if (arg === undefined || arg === "") {
    console.error(
      "Usage: agent-comms bridge cc-peer <target-name> | --pid=<pid>",
    );
    process.exit(1);
  }
  if (arg.startsWith(PID_FLAG_PREFIX)) {
    const pid = Number(arg.slice(PID_FLAG_PREFIX.length));
    if (!Number.isInteger(pid) || pid <= 0) {
      console.error(`Invalid --pid value: ${arg}`);
      process.exit(1);
    }
    return { pid };
  }
  return { name: arg };
}

export async function run(): Promise<void> {
  const target = parseTarget(process.argv.slice(BRIDGE_ARGS_START_INDEX));

  const identitySlot: IdentitySlot = { harness: "cc-peer", cwd: process.cwd() };
  // cc-peer allows one peer per process, so this is the only one: the default front borrows it below rather than creating its own, and the front leaves this bridge's own target alone since the relay below already covers it.
  const peer = await CcPeer.create({ name: "agent-comms-bridge" });
  const { store, tool } = await createBridgeMesh(identitySlot);
  store.onError = createMeshErrorReporter();
  store.getCcPeerVersion = () => CC_PEER_VERSION;
  store.onCoordinatorRoleChanged = wireDefaultCcPeerFront(store, {
    peer,
    excludeSession: (entry) => targetMatchesEntry(target, entry),
  });

  const reg = await ensureRegistered({
    store,
    cwd: process.cwd(),
    harness: "cc-peer",
    defaultName: "cc-peer-bridge",
  });
  const roomId = await ensureProjectRoom(store, reg.agentId, process.cwd());

  wireCcPeerBridge({
    store,
    tool,
    peer,
    agentId: reg.agentId,
    roomId,
    target,
    cwd: process.cwd(),
    isFromTarget: createTargetSenderMatcher(target, async () => peer.roster()),
  });

  await store.init();

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });

  async function shutdown(): Promise<void> {
    await peer.stop();
    await store.setAgentOffline(reg.agentId);
    releaseIdentityLock(identitySlot);
    await store.shutdown();
    process.exit(0);
  }
}

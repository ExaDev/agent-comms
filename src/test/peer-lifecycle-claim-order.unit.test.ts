/**
 * The state of a coordinator read before the claim that names it is accepted, with a real CoordinatorRole: the snapshot and the claim arrive on different queues of one session, so either can be read first, and a joiner must end with the coordinator's records whichever it is.
 */

import { expect, test, vi } from "vitest";
import { deviceIdFromHex } from "wire-mesh-core/domain/device-id";
import { CoordinatorRole } from "../core/coordinator-role.js";
import { KnownAgents } from "../core/known-agents.js";
import {
  PeerLifecycle,
  type PeerLifecycleDeps,
} from "../core/peer-lifecycle.js";
import type { AgentIdentity } from "../core/types.js";
import type { SerialisedState } from "../core/wire-protocol.js";

const DEVICE_ID_HEX_LENGTH = 64;
const SELF = "1".repeat(DEVICE_ID_HEX_LENGTH);
const HOLDER = "2".repeat(DEVICE_ID_HEX_LENGTH);
const RELAYED = "3".repeat(DEVICE_ID_HEX_LENGTH);

function relayed(): AgentIdentity {
  return {
    id: RELAYED,
    version: 1,
    name: "relayed",
    harness: "pi",
    cwd: "/tmp",
    pid: 1,
    startedAt: "2026-01-01T00:00:00.000Z",
    visibility: "visible",
    status: "offline",
    tags: [],
    subscribedRooms: [],
  };
}

function snapshot(): SerialisedState {
  return {
    agents: { [RELAYED]: relayed() },
    rooms: {},
    messages: {},
    dms: {},
    deliveryQueues: {},
  };
}

function joiner(): {
  lifecycle: PeerLifecycle;
  role: CoordinatorRole;
  applyStateSync: ReturnType<
    typeof vi.fn<PeerLifecycleDeps["deliveryEngine"]["applyStateSync"]>
  >;
} {
  const role = new CoordinatorRole({
    getPeerId: () => SELF,
    claimWaitMs: 1000,
    requireTransport: () => ({
      broadcastCoordinatorClaim: async () => Promise.resolve(),
      sendCoordinatorClaim: async () => Promise.resolve(),
      electionPeerIds: () => new Set([HOLDER]),
    }),
    onGained: async () => Promise.resolve(),
    onLost: async () => Promise.resolve(),
    onError: (error) => {
      throw error;
    },
  });
  const applyStateSync =
    vi.fn<PeerLifecycleDeps["deliveryEngine"]["applyStateSync"]>();
  const agents = new KnownAgents();
  const deps: PeerLifecycleDeps = {
    peerInfo: new Map(),
    agents,
    coordinatorPort: 1,
    getPeerId: () => SELF,
    getCoordinatorPeerId: () => undefined,
    staleAgentChecker: {
      forget: () => {},
    },
    requireTransport: () => ({}) as never,
    serialise: () => snapshot(),
    roomProtocol: { flushPendingRoomRequests: async () => Promise.resolve() },
    deliveryEngine: {
      applyStateSync,
      applyPatch: async () => Promise.resolve(),
      notifyRoomsOfStatus: async () => Promise.resolve(),
      broadcastPatch: async () => Promise.resolve(),
      bump: (entity) => entity,
    },
    coordinatorRole: role,
  };
  return { lifecycle: new PeerLifecycle(deps), role, applyStateSync };
}

const claim = {
  type: "coordinator",
  term: 0,
  coordinator: deviceIdFromHex(HOLDER),
} as const;

test("a snapshot read before the claim that names its sender is accepted still gives the joiner the relayed records", async () => {
  const { lifecycle, role, applyStateSync } = joiner();

  await lifecycle.handleDataMessage(
    { id: HOLDER },
    { method: "state_sync", state: snapshot() },
  );
  expect(applyStateSync).toHaveBeenLastCalledWith(
    expect.objectContaining({ agents: {} }),
  );

  await role.handleClaim({ id: HOLDER }, claim);

  expect(applyStateSync).toHaveBeenLastCalledWith(
    expect.objectContaining({ agents: { [RELAYED]: relayed() } }),
  );
});

test("a snapshot read after the claim is taken at once", async () => {
  const { lifecycle, role, applyStateSync } = joiner();

  await role.handleClaim({ id: HOLDER }, claim);
  await lifecycle.handleDataMessage(
    { id: HOLDER },
    { method: "state_sync", state: snapshot() },
  );

  expect(applyStateSync).toHaveBeenCalledTimes(1);
  expect(applyStateSync).toHaveBeenLastCalledWith(
    expect.objectContaining({ agents: { [RELAYED]: relayed() } }),
  );
});

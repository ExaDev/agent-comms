/**
 * PeerLifecycle's crash-race coordinator failover decision (agent-comms#285), exercised against fakes: which disconnects contest the vacated coordinator role, what a peer that loses the bind race does instead, and who retires a departed peer's own agent record. The real-socket counterpart lives in coordinator-failover.integration.test.ts.
 */

import { test, expect } from "vitest";
import { PeerLifecycle } from "../core/peer-lifecycle.js";
import type { PeerLifecycleDeps } from "../core/peer-lifecycle.js";
import type { MeshTransport } from "../core/transport.js";
import type { MeshStatePatch, PeerInfo } from "../core/wire-protocol.js";
import type { AgentIdentity, AgentStatus } from "../core/types.js";

const COORDINATOR_PORT = 19_876;
const SELF_DATA_PORT = 41_001;
const COORDINATOR_DATA_PORT = 41_002;
const SURVIVOR_DATA_PORT = 41_003;

const SELF_ID = "self-peer";
const COORDINATOR_ID = "coordinator-peer";
const SURVIVOR_ID = "survivor-peer";

interface TransportCalls {
  becomeCoordinator: { host: string; port: number }[];
  connectToCoordinator: { port: number; peerId: string; dataPort: number }[];
  connectToPeer: string[];
  broadcasts: MeshStatePatch[];
}

interface Harness {
  lifecycle: PeerLifecycle;
  calls: TransportCalls;
  peerInfo: Map<string, PeerInfo>;
  agents: Map<string, AgentIdentity>;
  roomStatusNotifications: { agentId: string; status: AgentStatus }[];
  staleCheckerStarts: number;
  gatewayDials: number;
  roleChanges: number;
  errors: Error[];
}

function peer(id: string, port: number, startedAt: string): PeerInfo {
  return { id, port, startedAt };
}

function agentRecord(id: string, status: AgentStatus): AgentIdentity {
  return {
    id,
    version: 1,
    name: id,
    harness: "test",
    cwd: `/test/${id}`,
    pid: process.pid,
    startedAt: "2026-01-01T00:00:00.000Z",
    visibility: "visible",
    status,
    tags: [],
    subscribedRooms: [],
  };
}

interface HarnessOptions {
  /** Whether this side already holds the coordinator role before the disconnect arrives. */
  isCoordinator?: boolean;
  /** The coordinator this side currently answers to, as the transport reports it. */
  coordinatorPeerId?: string | undefined;
  /** Rejection thrown by the transport's becomeCoordinator, simulating another survivor winning the bind race. */
  bindFailure?: Error;
}

function makeHarness(options: Readonly<HarnessOptions> = {}): Harness {
  const calls: TransportCalls = {
    becomeCoordinator: [],
    connectToCoordinator: [],
    connectToPeer: [],
    broadcasts: [],
  };
  const harness: Harness = {
    // Assigned below, once the deps it closes over exist.
    lifecycle: undefined as unknown as PeerLifecycle,
    calls,
    peerInfo: new Map<string, PeerInfo>(),
    agents: new Map<string, AgentIdentity>(),
    roomStatusNotifications: [],
    staleCheckerStarts: 0,
    gatewayDials: 0,
    roleChanges: 0,
    errors: [],
  };

  let isCoordinator = options.isCoordinator ?? false;
  const transport: MeshTransport = {
    dataPort: SELF_DATA_PORT,
    get isCoordinator(): boolean {
      return isCoordinator;
    },
    hasCoordinatorConnection: false,
    coordinatorPeerId: options.coordinatorPeerId,
    startDataServer: async () => {},
    connectToCoordinator: async (_host, port, peerId, dataPort) => {
      calls.connectToCoordinator.push({ port, peerId, dataPort });
    },
    becomeCoordinator: async (host, port) => {
      calls.becomeCoordinator.push({ host, port });
      if (options.bindFailure !== undefined) throw options.bindFailure;
      isCoordinator = true;
    },
    connectToPeer: async (target) => {
      calls.connectToPeer.push(target.id);
    },
    send: async () => {},
    acceptConnection: async () => {},
    rejectConnection: async () => {},
    connectToRemote: async () => {},
    broadcast: async () => {},
    broadcastRevocation: async () => {},
    sendRoomRequest: async () => ({ result: "ok" }),
    addListener: async () => "listener",
    removeListener: async () => {},
    listListeners: () => [],
    shutdown: async () => {},
    unref: () => {},
  };

  const deps: PeerLifecycleDeps = {
    peerInfo: harness.peerInfo,
    agents: harness.agents,
    coordinatorPort: COORDINATOR_PORT,
    getPeerId: () => SELF_ID,
    getCoordinatorPeerId: () => transport.coordinatorPeerId,
    requireTransport: () => transport,
    serialise: () => ({
      agents: {},
      rooms: {},
      messages: {},
      dms: {},
      deliveryQueues: {},
    }),
    roomProtocol: { flushPendingRoomRequests: async () => {} },
    deliveryEngine: {
      applyStateSync: () => {},
      applyPatch: async () => {},
      notifyRoomsOfStatus: async (agentId, status) => {
        harness.roomStatusNotifications.push({ agentId, status });
      },
      broadcastPatch: async (patch) => {
        calls.broadcasts.push(patch);
      },
    },
    staleAgentChecker: {
      start: () => {
        harness.staleCheckerStarts += 1;
      },
    },
    coordinatorGateway: {
      onBecameCoordinator: async () => {
        harness.gatewayDials += 1;
      },
    },
    onCoordinatorRoleChanged: () => {
      harness.roleChanges += 1;
    },
    onError: (error) => {
      harness.errors.push(error);
    },
  };

  harness.lifecycle = new PeerLifecycle(deps);
  return harness;
}

/** The peer list every test starts from: this side, the coordinator that is about to die, and one other survivor. */
function seedMesh(harness: Harness): void {
  harness.peerInfo.set(
    SELF_ID,
    peer(SELF_ID, SELF_DATA_PORT, "2026-01-01T00:00:02.000Z"),
  );
  harness.peerInfo.set(
    COORDINATOR_ID,
    peer(COORDINATOR_ID, COORDINATOR_DATA_PORT, "2026-01-01T00:00:00.000Z"),
  );
  harness.peerInfo.set(
    SURVIVOR_ID,
    peer(SURVIVOR_ID, SURVIVOR_DATA_PORT, "2026-01-01T00:00:01.000Z"),
  );
}

test("the coordinator's own disconnect makes this peer contest the coordinator port", async () => {
  const harness = makeHarness({ coordinatorPeerId: COORDINATOR_ID });
  seedMesh(harness);

  await harness.lifecycle.handlePeerDeparture(COORDINATOR_ID);

  expect(harness.calls.becomeCoordinator).toEqual([
    { host: "127.0.0.1", port: COORDINATOR_PORT },
  ]);
  expect(harness.staleCheckerStarts).toBe(1);
  expect(harness.gatewayDials).toBe(1);
  expect(harness.roleChanges).toBe(1);
  expect(harness.errors).toEqual([]);
});

test("taking over keeps this peer's own entry and drops the dead coordinator's", async () => {
  const harness = makeHarness({ coordinatorPeerId: COORDINATOR_ID });
  seedMesh(harness);

  await harness.lifecycle.handlePeerDeparture(COORDINATOR_ID);

  expect([...harness.peerInfo.keys()].sort()).toEqual(
    [SELF_ID, SURVIVOR_ID].sort(),
  );
  expect(harness.calls.connectToPeer).toEqual([SURVIVOR_ID]);
});

test("an ordinary peer's disconnect never contests the coordinator role", async () => {
  const harness = makeHarness({ coordinatorPeerId: COORDINATOR_ID });
  seedMesh(harness);

  await harness.lifecycle.handlePeerDeparture(SURVIVOR_ID);

  expect(harness.calls.becomeCoordinator).toEqual([]);
  expect(harness.calls.connectToCoordinator).toEqual([]);
  expect(harness.peerInfo.has(SURVIVOR_ID)).toBe(false);
});

test("a peer that already holds the coordinator role never contests it", async () => {
  const harness = makeHarness({
    isCoordinator: true,
    coordinatorPeerId: COORDINATOR_ID,
  });
  seedMesh(harness);

  await harness.lifecycle.handlePeerDeparture(COORDINATOR_ID);

  expect(harness.calls.becomeCoordinator).toEqual([]);
});

test("losing the bind race makes this peer rejoin under the new coordinator", async () => {
  const harness = makeHarness({
    coordinatorPeerId: COORDINATOR_ID,
    bindFailure: new Error("listen EADDRINUSE: address already in use"),
  });
  seedMesh(harness);

  await harness.lifecycle.handlePeerDeparture(COORDINATOR_ID);

  expect(harness.calls.becomeCoordinator).toHaveLength(1);
  expect(harness.calls.connectToCoordinator).toEqual([
    { port: COORDINATOR_PORT, peerId: SELF_ID, dataPort: SELF_DATA_PORT },
  ]);
  expect(harness.staleCheckerStarts).toBe(0);
  expect(harness.errors).toEqual([]);
});

test("a bind failure that is not a port conflict is reported, not retried as a rejoin", async () => {
  const harness = makeHarness({
    coordinatorPeerId: COORDINATOR_ID,
    bindFailure: new Error("EACCES: permission denied"),
  });
  seedMesh(harness);

  await harness.lifecycle.handlePeerDeparture(COORDINATOR_ID);

  expect(harness.calls.connectToCoordinator).toEqual([]);
  expect(harness.errors.map((error) => error.message)).toEqual([
    "PeerLifecycle: could not take over the vacated coordinator role: EACCES: permission denied",
  ]);
});

test("the coordinator retires a departed peer's own agent record", async () => {
  const harness = makeHarness({ isCoordinator: true });
  seedMesh(harness);
  harness.agents.set(SURVIVOR_ID, agentRecord(SURVIVOR_ID, "active"));

  await harness.lifecycle.handlePeerDeparture(SURVIVOR_ID);

  expect(harness.agents.get(SURVIVOR_ID)?.status).toBe("offline");
  expect(harness.roomStatusNotifications).toEqual([
    { agentId: SURVIVOR_ID, status: "offline" },
  ]);
  expect(harness.calls.broadcasts).toEqual([
    { type: "agent_offline", agentId: SURVIVOR_ID },
  ]);
});

test("a peer that takes over retires the dead coordinator's own agent record", async () => {
  const harness = makeHarness({ coordinatorPeerId: COORDINATOR_ID });
  seedMesh(harness);
  harness.agents.set(COORDINATOR_ID, agentRecord(COORDINATOR_ID, "active"));

  await harness.lifecycle.handlePeerDeparture(COORDINATOR_ID);

  expect(harness.agents.get(COORDINATOR_ID)?.status).toBe("offline");
  expect(harness.calls.broadcasts).toEqual([
    { type: "agent_offline", agentId: COORDINATOR_ID },
  ]);
});

test("a peer that loses the race leaves the offline announcement to the winner", async () => {
  const harness = makeHarness({
    coordinatorPeerId: COORDINATOR_ID,
    bindFailure: new Error("listen EADDRINUSE: address already in use"),
  });
  seedMesh(harness);
  harness.agents.set(COORDINATOR_ID, agentRecord(COORDINATOR_ID, "active"));

  await harness.lifecycle.handlePeerDeparture(COORDINATOR_ID);

  expect(harness.calls.broadcasts).toEqual([]);
  expect(harness.roomStatusNotifications).toEqual([]);
});

/**
 * PeerLifecycle's failover decisions, exercised against fakes with a real CoordinatorRole: which disconnects contest the vacated well-known port (agent-comms#285), what a peer that loses the bind race does instead, how the elected coordinator role is recovered when its holder departs (agent-comms#341), and who retires a departed peer's own agent record. The real-socket counterparts live in coordinator-failover.integration.test.ts and coordinator-election.integration.test.ts.
 */

import { afterEach, test, expect, vi } from "vitest";
import { deviceIdFromHex } from "wire-mesh-core/domain/device-id";
import type { CoordinatorFrame } from "wire-mesh-core/generated/protocol";
import { PeerLifecycle } from "../core/peer-lifecycle.js";
import type { PeerLifecycleDeps } from "../core/peer-lifecycle.js";
import { CoordinatorRole } from "../core/coordinator-role.js";
import { ROOM_REQUEST_TIMEOUT_MS } from "../core/request-timeouts.js";
import type { MeshTransport } from "../core/transport.js";
import type { MeshStatePatch, PeerInfo } from "../core/wire-protocol.js";
import type { AgentIdentity, AgentStatus } from "../core/types.js";

const COORDINATOR_PORT = 19_876;
const SELF_DATA_PORT = 41_001;
const COORDINATOR_DATA_PORT = 41_002;
const SURVIVOR_DATA_PORT = 41_003;

const DEVICE_ID_HEX_LENGTH = 64;
/** Device-ids in ascending order, so which survivor is the lowest is fixed per test: the departing peer sorts first, then this side, then the other survivor, unless a test swaps the last two. */
const COORDINATOR_ID = "1".repeat(DEVICE_ID_HEX_LENGTH);
const LOW_ID = "2".repeat(DEVICE_ID_HEX_LENGTH);
const HIGH_ID = "3".repeat(DEVICE_ID_HEX_LENGTH);

interface TransportCalls {
  becomeCoordinator: { host: string; port: number }[];
  connectToCoordinator: { port: number; peerId: string; dataPort: number }[];
  connectToPeer: string[];
  broadcasts: MeshStatePatch[];
  claims: CoordinatorFrame[];
}

interface Harness {
  lifecycle: PeerLifecycle;
  role: CoordinatorRole;
  calls: TransportCalls;
  peerInfo: Map<string, PeerInfo>;
  agents: Map<string, AgentIdentity>;
  roomStatusNotifications: { agentId: string; status: AgentStatus }[];
  gains: number;
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

function claimFor(holderHex: string, term: number): CoordinatorFrame {
  return { type: "coordinator", term, coordinator: deviceIdFromHex(holderHex) };
}

interface HarnessOptions {
  /** This side's own device-id; LOW_ID unless a test needs this side not to be the lowest survivor. */
  selfId?: string;
  /** The other survivor's device-id. */
  survivorId?: string;
  /** Whether this side already holds the well-known port listener before the disconnect arrives. */
  isCoordinator?: boolean;
  /** The port holder this side currently answers to, as the transport reports it. */
  coordinatorPeerId?: string | undefined;
  /** Rejection thrown by the transport's becomeCoordinator, simulating another survivor winning the bind race. */
  bindFailure?: Error;
}

function makeHarness(options: Readonly<HarnessOptions> = {}): Harness {
  const selfId = options.selfId ?? LOW_ID;
  const calls: TransportCalls = {
    becomeCoordinator: [],
    connectToCoordinator: [],
    connectToPeer: [],
    broadcasts: [],
    claims: [],
  };
  const peerInfo = new Map<string, PeerInfo>();
  const agents = new Map<string, AgentIdentity>();
  const roomStatusNotifications: Harness["roomStatusNotifications"] = [];
  const errors: Error[] = [];
  let gains = 0;

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
    broadcastCoordinatorClaim: async (frame) => {
      calls.claims.push(frame);
    },
    sendCoordinatorClaim: async () => {},
    electionPeerIds: () => new Set<string>(),
    sendRoomRequest: async () => ({ result: "ok" }),
    addListener: async () => "listener",
    removeListener: async () => {},
    listListeners: () => [],
    shutdown: async () => {},
    unref: () => {},
  };

  const role = new CoordinatorRole({
    getPeerId: () => selfId,
    livePeerIds: () => peerInfo.keys(),
    requireTransport: () => transport,
    onGained: async () => {
      gains += 1;
    },
    onLost: async () => {},
    onError: (error) => {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    },
  });

  const deps: PeerLifecycleDeps = {
    peerInfo,
    agents,
    coordinatorPort: COORDINATOR_PORT,
    getPeerId: () => selfId,
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
        roomStatusNotifications.push({ agentId, status });
      },
      broadcastPatch: async (patch) => {
        calls.broadcasts.push(patch);
      },
    },
    coordinatorRole: role,
    onError: (error) => {
      errors.push(error);
    },
  };

  peerInfo.set(
    selfId,
    peer(selfId, SELF_DATA_PORT, "2026-01-01T00:00:02.000Z"),
  );
  peerInfo.set(
    COORDINATOR_ID,
    peer(COORDINATOR_ID, COORDINATOR_DATA_PORT, "2026-01-01T00:00:00.000Z"),
  );
  const survivorId = options.survivorId ?? HIGH_ID;
  peerInfo.set(
    survivorId,
    peer(survivorId, SURVIVOR_DATA_PORT, "2026-01-01T00:00:01.000Z"),
  );

  return {
    lifecycle: new PeerLifecycle(deps),
    role,
    calls,
    peerInfo,
    agents,
    roomStatusNotifications,
    get gains() {
      return gains;
    },
    errors,
  };
}

/** Makes holderHex the elected incumbent at term, as if its claim had just been gossiped to this side. */
async function electHolder(
  harness: Harness,
  holderHex: string,
  term: number,
): Promise<void> {
  await harness.role.handleClaim({ id: holderHex }, claimFor(holderHex, term));
  harness.calls.claims.length = 0;
}

afterEach(() => {
  vi.useRealTimers();
});

test("the port holder's own disconnect makes this peer contest the well-known port", async () => {
  const harness = makeHarness({ coordinatorPeerId: COORDINATOR_ID });

  await harness.lifecycle.handlePeerDeparture(COORDINATOR_ID);

  expect(harness.calls.becomeCoordinator).toEqual([
    { host: "127.0.0.1", port: COORDINATOR_PORT },
  ]);
  expect(harness.errors).toEqual([]);
});

test("winning the vacated port does not by itself carry the coordinator duties while another live peer holds the elected role", async () => {
  const harness = makeHarness({ coordinatorPeerId: COORDINATOR_ID });
  await electHolder(harness, HIGH_ID, 0);

  await harness.lifecycle.handlePeerDeparture(COORDINATOR_ID);

  expect(harness.calls.becomeCoordinator).toHaveLength(1);
  expect(harness.role.isHolder()).toBe(false);
  expect(harness.gains).toBe(0);
  expect(harness.calls.claims).toEqual([]);
});

test("taking over the port keeps this peer's own entry and drops the dead holder's", async () => {
  const harness = makeHarness({ coordinatorPeerId: COORDINATOR_ID });

  await harness.lifecycle.handlePeerDeparture(COORDINATOR_ID);

  expect([...harness.peerInfo.keys()].sort()).toEqual([LOW_ID, HIGH_ID].sort());
  expect(harness.calls.connectToPeer).toEqual([HIGH_ID]);
});

test("an ordinary peer's disconnect contests neither the port nor the elected role", async () => {
  const harness = makeHarness({ coordinatorPeerId: COORDINATOR_ID });
  await electHolder(harness, COORDINATOR_ID, 0);

  await harness.lifecycle.handlePeerDeparture(HIGH_ID);

  expect(harness.calls.becomeCoordinator).toEqual([]);
  expect(harness.calls.connectToCoordinator).toEqual([]);
  expect(harness.calls.claims).toEqual([]);
  expect(harness.peerInfo.has(HIGH_ID)).toBe(false);
});

test("a peer that already holds the port listener never contests it", async () => {
  const harness = makeHarness({
    isCoordinator: true,
    coordinatorPeerId: COORDINATOR_ID,
  });

  await harness.lifecycle.handlePeerDeparture(COORDINATOR_ID);

  expect(harness.calls.becomeCoordinator).toEqual([]);
});

test("losing the bind race makes this peer rejoin under the new port holder", async () => {
  const harness = makeHarness({
    coordinatorPeerId: COORDINATOR_ID,
    bindFailure: new Error("listen EADDRINUSE: address already in use"),
  });

  await harness.lifecycle.handlePeerDeparture(COORDINATOR_ID);

  expect(harness.calls.becomeCoordinator).toHaveLength(1);
  expect(harness.calls.connectToCoordinator).toEqual([
    { port: COORDINATOR_PORT, peerId: LOW_ID, dataPort: SELF_DATA_PORT },
  ]);
  expect(harness.errors).toEqual([]);
});

test("a bind failure that is not a port conflict is reported, not retried as a rejoin", async () => {
  const harness = makeHarness({
    coordinatorPeerId: COORDINATOR_ID,
    bindFailure: new Error("EACCES: permission denied"),
  });

  await harness.lifecycle.handlePeerDeparture(COORDINATOR_ID);

  expect(harness.calls.connectToCoordinator).toEqual([]);
  expect(harness.errors.map((error) => error.message)).toEqual([
    "PeerLifecycle: could not take over the vacated coordinator port: EACCES: permission denied",
  ]);
});

test("the elected holder's departure makes the lowest surviving device-id claim the role at a raised term, whether or not it wins the port", async () => {
  const harness = makeHarness({
    coordinatorPeerId: COORDINATOR_ID,
    bindFailure: new Error("listen EADDRINUSE: address already in use"),
  });
  const departedTerm = 3;
  await electHolder(harness, COORDINATOR_ID, departedTerm);

  await harness.lifecycle.handlePeerDeparture(COORDINATOR_ID);

  expect(harness.calls.claims).toEqual([claimFor(LOW_ID, departedTerm + 1)]);
  expect(harness.role.isHolder()).toBe(true);
  expect(harness.gains).toBe(1);
  expect(harness.calls.becomeCoordinator).toHaveLength(1);
});

test("a survivor that is not the lowest device-id leaves the claim to the lowest one", async () => {
  vi.useFakeTimers();
  const harness = makeHarness({ selfId: HIGH_ID, survivorId: LOW_ID });
  await electHolder(harness, COORDINATOR_ID, 0);

  await harness.lifecycle.handlePeerDeparture(COORDINATOR_ID);
  await harness.role.handleClaim({ id: LOW_ID }, claimFor(LOW_ID, 1));
  harness.calls.claims.length = 0;
  await vi.advanceTimersByTimeAsync(ROOM_REQUEST_TIMEOUT_MS);

  expect(harness.role.isHolder()).toBe(false);
  expect(harness.role.current()).toEqual({ term: 1, holder: LOW_ID });
  expect(harness.calls.claims).toEqual([]);
});

test("a survivor claims the role itself once the expected successor's claim never arrives, and retires the departed holder", async () => {
  vi.useFakeTimers();
  const harness = makeHarness({ selfId: HIGH_ID, survivorId: LOW_ID });
  harness.agents.set(COORDINATOR_ID, agentRecord(COORDINATOR_ID, "active"));
  await electHolder(harness, COORDINATOR_ID, 0);

  await harness.lifecycle.handlePeerDeparture(COORDINATOR_ID);
  expect(harness.calls.claims).toEqual([]);
  await vi.advanceTimersByTimeAsync(ROOM_REQUEST_TIMEOUT_MS);

  expect(harness.calls.claims).toEqual([claimFor(HIGH_ID, 1)]);
  expect(harness.role.isHolder()).toBe(true);
  expect(harness.agents.get(COORDINATOR_ID)?.status).toBe("offline");
  expect(harness.calls.broadcasts).toEqual([
    { type: "agent_offline", agentId: COORDINATOR_ID },
  ]);
});

test("the elected holder retires a departed peer's own agent record", async () => {
  const harness = makeHarness();
  await harness.role.claimIfVacant();
  harness.agents.set(HIGH_ID, agentRecord(HIGH_ID, "active"));

  await harness.lifecycle.handlePeerDeparture(HIGH_ID);

  expect(harness.agents.get(HIGH_ID)?.status).toBe("offline");
  expect(harness.roomStatusNotifications).toEqual([
    { agentId: HIGH_ID, status: "offline" },
  ]);
  expect(harness.calls.broadcasts).toEqual([
    { type: "agent_offline", agentId: HIGH_ID },
  ]);
});

test("holding only the port listener gives no authority to retire a departed peer", async () => {
  const harness = makeHarness({ isCoordinator: true });
  await electHolder(harness, COORDINATOR_ID, 0);
  harness.agents.set(HIGH_ID, agentRecord(HIGH_ID, "active"));

  await harness.lifecycle.handlePeerDeparture(HIGH_ID);

  expect(harness.agents.get(HIGH_ID)?.status).toBe("active");
  expect(harness.calls.broadcasts).toEqual([]);
});

test("a peer that takes over the elected role retires the dead holder's own agent record", async () => {
  const harness = makeHarness({ coordinatorPeerId: COORDINATOR_ID });
  await electHolder(harness, COORDINATOR_ID, 0);
  harness.agents.set(COORDINATOR_ID, agentRecord(COORDINATOR_ID, "active"));

  await harness.lifecycle.handlePeerDeparture(COORDINATOR_ID);

  expect(harness.agents.get(COORDINATOR_ID)?.status).toBe("offline");
  expect(harness.calls.broadcasts).toEqual([
    { type: "agent_offline", agentId: COORDINATOR_ID },
  ]);
});

test("a survivor that does not take over the elected role leaves the offline announcement to the new holder, even when it wins the port", async () => {
  vi.useFakeTimers();
  const harness = makeHarness({
    selfId: HIGH_ID,
    survivorId: LOW_ID,
    coordinatorPeerId: COORDINATOR_ID,
  });
  await electHolder(harness, COORDINATOR_ID, 0);
  harness.agents.set(COORDINATOR_ID, agentRecord(COORDINATOR_ID, "active"));

  await harness.lifecycle.handlePeerDeparture(COORDINATOR_ID);

  expect(harness.calls.becomeCoordinator).toHaveLength(1);
  expect(harness.calls.broadcasts).toEqual([]);
  expect(harness.roomStatusNotifications).toEqual([]);
});

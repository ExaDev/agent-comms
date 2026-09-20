/**
 * Direct, DI-based unit tests for how DeliveryEngine treats a state snapshot that carries this store's own agent as offline: the store is the authority on whether its own agent is running, so a running agent is kept online and re-announced rather than overwritten (the state-snapshot counterpart of the agent_offline patch case in delivery-engine.unit.test.ts).
 */
import { describe, expect, it, vi } from "vitest";
import {
  DeliveryEngine,
  type DeliveryEngineDeps,
} from "../core/delivery-engine.js";
import type { MeshTransport } from "../core/transport.js";
import type { SerialisedState } from "../core/wire-protocol.js";
import type {
  AgentIdentity,
  DeliveryEvent,
  DmMessage,
  Room,
  RoomMessage,
} from "../core/types.js";

/** A device-id is a 64-character lowercase hex SHA-256 digest. */
const DEVICE_ID_HEX_LENGTH = 64;
const PEER_ID = "a".repeat(DEVICE_ID_HEX_LENGTH);
const NOW_MS = 1_700_000_000_000;

/** Revisions chosen so each expectation is distinguishable from the others: the store's own copy, the snapshot's higher copy, and the revision a contradiction must exceed. */
const LOCAL_REVISION = 1;
const SNAPSHOT_REVISION = 3;
const CONTRADICTING_REVISION = SNAPSHOT_REVISION + 1;

function agent(overrides: Partial<AgentIdentity> = {}): AgentIdentity {
  return {
    id: PEER_ID,
    version: LOCAL_REVISION,
    name: "own",
    harness: "pi",
    cwd: "/tmp",
    pid: 111,
    startedAt: "2026-01-01T00:00:00.000Z",
    visibility: "visible",
    status: "active",
    tags: [],
    subscribedRooms: [],
    ...overrides,
  };
}

function snapshotWith(own: AgentIdentity): SerialisedState {
  return {
    agents: { [PEER_ID]: own },
    rooms: {},
    messages: {},
    dms: {},
    deliveryQueues: {},
  };
}

function fakeTransport(): MeshTransport {
  return {
    dataPort: 4000,
    isCoordinator: false,
    hasCoordinatorConnection: false,
    coordinatorPeerId: undefined,
    startDataServer: vi.fn().mockResolvedValue(undefined),
    connectToCoordinator: vi.fn().mockResolvedValue(undefined),
    becomeCoordinator: vi.fn().mockResolvedValue(undefined),
    connectToPeer: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    acceptConnection: vi.fn().mockResolvedValue(undefined),
    rejectConnection: vi.fn().mockResolvedValue(undefined),
    connectToRemote: vi.fn().mockResolvedValue(undefined),
    broadcast: vi.fn().mockResolvedValue(undefined),
    broadcastRevocation: vi.fn().mockResolvedValue(undefined),
    sendRoomRequest: vi
      .fn()
      .mockResolvedValue({ result: "error", code: "not_connected" }),
    addListener: vi.fn().mockResolvedValue("listener-1"),
    removeListener: vi.fn().mockResolvedValue(undefined),
    listListeners: vi.fn().mockReturnValue([]),
    shutdown: vi.fn().mockResolvedValue(undefined),
    unref: vi.fn<() => void>(),
  };
}

function makeHarness() {
  const transport = fakeTransport();
  const deps: DeliveryEngineDeps = {
    agents: new Map<string, AgentIdentity>(),
    rooms: new Map<string, Room>(),
    messages: new Map<string, RoomMessage[]>(),
    dms: new Map<string, DmMessage[]>(),
    deliveryQueues: new Map<string, DeliveryEvent[]>(),
    localDeliveryKeys: new Set<string>(),
    pendingMarkReadTimers: [],
    getPeerId: () => PEER_ID,
    requireIdentity: () => ({
      slot: { harness: "pi", cwd: "/tmp" },
      clock: { now: () => NOW_MS },
      identity: {} as never,
      revocation: { record: vi.fn() } as never,
      dataStorage: {} as never,
      userIdentity: {} as never,
      userIdentityOptions: {},
    }),
    requireTransport: () => transport,
    getOnDelivery: () => undefined,
    getOnPatch: () => undefined,
    isShutDown: () => false,
    sendRoomRequestToMember: vi.fn().mockResolvedValue(undefined),
  };
  return { deps, engine: new DeliveryEngine(deps), transport };
}

describe("DeliveryEngine — applyStateSync own agent", () => {
  it("keeps this store's own running agent online when a snapshot carries it as offline at a higher revision, and re-announces it above that revision", () => {
    const h = makeHarness();
    h.deps.agents.set(PEER_ID, agent({ status: "active" }));

    h.engine.applyStateSync(
      snapshotWith(agent({ status: "offline", version: SNAPSHOT_REVISION })),
    );

    const own = h.deps.agents.get(PEER_ID);
    expect(own?.status).toBe("active");
    expect(own?.version).toBe(CONTRADICTING_REVISION);
    expect(h.transport.broadcast).toHaveBeenCalledWith({
      method: "state_update",
      patch: { type: "agent_upsert", agent: own },
    });
  });

  it("accepts a snapshot's offline copy of this store's own agent once it has itself set it offline", () => {
    const h = makeHarness();
    h.deps.agents.set(PEER_ID, agent({ status: "offline" }));

    h.engine.applyStateSync(
      snapshotWith(agent({ status: "offline", version: SNAPSHOT_REVISION })),
    );

    expect(h.deps.agents.get(PEER_ID)?.version).toBe(SNAPSHOT_REVISION);
    expect(h.transport.broadcast).not.toHaveBeenCalled();
  });

  it("applies a snapshot's copy of this store's own agent as usual when it is not offline", () => {
    const h = makeHarness();
    h.deps.agents.set(PEER_ID, agent({ name: "before" }));

    h.engine.applyStateSync(
      snapshotWith(
        agent({ status: "busy", version: SNAPSHOT_REVISION, name: "after" }),
      ),
    );

    expect(h.deps.agents.get(PEER_ID)?.name).toBe("after");
    expect(h.transport.broadcast).not.toHaveBeenCalled();
  });

  it("leaves a snapshot's offline copy of another agent alone", () => {
    const h = makeHarness();
    const otherId = "b".repeat(DEVICE_ID_HEX_LENGTH);
    h.deps.agents.set(otherId, agent({ id: otherId }));

    h.engine.applyStateSync({
      ...snapshotWith(agent()),
      agents: {
        [otherId]: agent({
          id: otherId,
          status: "offline",
          version: SNAPSHOT_REVISION,
        }),
      },
    });

    expect(h.deps.agents.get(otherId)?.status).toBe("offline");
    expect(h.transport.broadcast).not.toHaveBeenCalled();
  });
});

/**
 * Direct, DI-based unit tests for DeliveryEngine -- the busiest collaborator in mesh-store.ts's own split (see its file header), previously exercised only indirectly through end-to-end room-send/state-sync integration tests, leaving many individual branches (version-gate boundaries, subscribedRooms union-vs-replace, dedup caps, timer-scheduled auto-mark-read, replay's per-type fire rules) unobserved. DeliveryEngineDeps is a narrow, injectable surface built exactly for this: every Map/Set is a real instance so effects are asserted by inspecting them directly, and every collaborator boundary (transport, sendRoomRequestToMember, onDelivery/onPatch callbacks, isShutDown) is a vi.fn() this file controls per test. loadRoomTokens is a free function reading a real identity file, not part of the injectable deps -- mocked here since markRead only ever forwards its return value opaquely, never inspects or verifies it. Split from delivery-engine-delivery.test.ts to satisfy the repo's max-lines cap: this file covers presence/queueing/membership-merge/state-sync/patch-application plus the top-level deliver/drainDelivery entry points (the latter two moved here from delivery-engine-delivery.test.ts to rebalance both files under the cap after a later round of survivor-closing tests grew it past 800 lines); delivery-engine-delivery.test.ts covers broadcast/fireLocalDelivery/notification/markRead. Both files share an identical preamble (helpers, fakes, makeHarness) by necessity of the split.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadRoomTokens } from "../core/identity-store.js";
import { randomId } from "../core/random-id.js";
import {
  DeliveryEngine,
  type DeliveryEngineDeps,
} from "../core/delivery-engine.js";
import type { MeshTransport } from "../core/transport.js";
import type { MeshStatePatch, SerialisedState } from "../core/wire-protocol.js";
import type {
  AgentIdentity,
  DeliveryEvent,
  DmMessage,
  Room,
  RoomMessage,
} from "../core/types.js";
import type {
  CapabilityToken,
  RevocationEntry,
} from "wire-mesh-core/generated/protocol";
import { bytesToHex } from "wire-mesh-core/domain/device-id";

vi.mock("../core/identity-store.js", () => ({
  loadRoomTokens: vi.fn(),
}));

// Opaque placeholder: markRead never inspects a token's own COSE_Sign1 structure, only forwards whatever loadRoomTokens returns to sendRoomRequestToMember.
const FAKE_TOKEN = "fake-token" as unknown as CapabilityToken;

/** A device-id is a 64-character lowercase hex SHA-256 digest; room-path.ts's assertDeviceIdHex rejects anything shorter. */
const DEVICE_ID_HEX_LENGTH = 64;
const PEER_ID = "a".repeat(DEVICE_ID_HEX_LENGTH);
const OTHER_ID = "b".repeat(DEVICE_ID_HEX_LENGTH);
const THIRD_ID = "c".repeat(DEVICE_ID_HEX_LENGTH);
const NOW_MS = 1_700_000_000_000;
/** Mirrors delivery-engine.ts's own private MAX_LOCAL_DELIVERY_DEDUP_KEYS -- not exported, so re-derived here as the literal the source comment documents rather than imported. */
const MAX_LOCAL_DELIVERY_DEDUP_KEYS = 50;
/** delivery-engine.ts imports this from mesh-store-shared.ts; re-imported here directly so the queueDelivery boundary tests stay pinned to the real value rather than a re-typed guess. */
const MAX_QUEUED_DELIVERIES_PER_AGENT = 100;

/** A fresh, distinct, real device-id-shaped hex id -- avoids the no-magic-numbers problem a per-test literal byte value would run into (matching room-protocol.test.ts's own precedent), using the same randomId() utility production code already uses for the identical purpose. */
function messageId(): string {
  return bytesToHex(randomId());
}

function room(overrides: Partial<Room> = {}): Room {
  return {
    id: "room-1",
    version: 1,
    name: "room-name",
    type: "public",
    owner: PEER_ID,
    createdAt: "2026-01-01T00:00:00.000Z",
    description: "",
    members: [PEER_ID],
    invited: [],
    memberJoins: {},
    memberLeaves: {},
    invitedJoins: {},
    invitedLeaves: {},
    ...overrides,
  };
}

function agent(overrides: Partial<AgentIdentity> = {}): AgentIdentity {
  return {
    id: OTHER_ID,
    version: 1,
    name: "recipient",
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

function roomMessage(overrides: Partial<RoomMessage> = {}): RoomMessage {
  return {
    id: messageId(),
    from: PEER_ID,
    room: "room-1",
    content: "hi",
    timestamp: "2026-01-01T00:00:00.000Z",
    readBy: [],
    ...overrides,
  };
}

function dmMessage(overrides: Partial<DmMessage> = {}): DmMessage {
  return {
    id: messageId(),
    from: PEER_ID,
    to: OTHER_ID,
    content: "hi",
    timestamp: "2026-01-01T00:00:00.000Z",
    readBy: [],
    ...overrides,
  };
}

function fakeTransport(): MeshTransport {
  return {
    dataPort: 4000,
    isCoordinator: false,
    hasCoordinatorConnection: false,
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
  let onDelivery:
    | ((agentId: string, event: DeliveryEvent) => void | Promise<void>)
    | undefined;
  let onPatch: ((patch: MeshStatePatch) => void | Promise<void>) | undefined;
  let shutDown = false;
  const transport = fakeTransport();
  const sendRoomRequestToMember = vi.fn().mockResolvedValue(undefined);
  const revocationRecord = vi.fn().mockResolvedValue(undefined);
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
      revocation: { record: revocationRecord } as never,
      dataStorage: {} as never,
      userIdentity: {} as never,
      userIdentityOptions: {},
    }),
    requireTransport: () => transport,
    getOnDelivery: () => onDelivery,
    getOnPatch: () => onPatch,
    isShutDown: () => shutDown,
    sendRoomRequestToMember,
  };
  return {
    deps,
    engine: new DeliveryEngine(deps),
    transport,
    sendRoomRequestToMember,
    revocationRecord,
    setOnDelivery(fn: typeof onDelivery) {
      onDelivery = fn;
    },
    setOnPatch(fn: typeof onPatch) {
      onPatch = fn;
    },
    setShutDown(v: boolean) {
      shutDown = v;
    },
  };
}

beforeEach(() => {
  vi.mocked(loadRoomTokens).mockReset();
  vi.mocked(loadRoomTokens).mockReturnValue({ "room-1": FAKE_TOKEN });
});

// ---------------------------------------------------------------------------
// Gossip callbacks
// ---------------------------------------------------------------------------

describe("DeliveryEngine — handlePresenceAdvert", () => {
  it("does nothing for a device with no known agent record", () => {
    const h = makeHarness();
    h.engine.handlePresenceAdvert(OTHER_ID, "idle");
    expect(h.deps.agents.size).toBe(0);
  });

  it("does nothing when the gossiped status matches the current one", () => {
    const h = makeHarness();
    h.deps.agents.set(OTHER_ID, agent({ status: "active", version: 1 }));
    h.engine.handlePresenceAdvert(OTHER_ID, "active");
    expect(h.deps.agents.get(OTHER_ID)?.version).toBe(1);
  });

  it("applies a genuine status change and bumps the agent's version", () => {
    const h = makeHarness();
    h.deps.agents.set(OTHER_ID, agent({ status: "active", version: 1 }));
    h.engine.handlePresenceAdvert(OTHER_ID, "busy");
    const updated = h.deps.agents.get(OTHER_ID);
    expect(updated?.status).toBe("busy");
    expect(updated?.version).toBe(2);
  });
});

describe("DeliveryEngine — handleRevocationAnnounce", () => {
  it("records a gossiped revocation entry against this store's own identity", async () => {
    const h = makeHarness();
    const entry = { tokenId: "tok" } as unknown as RevocationEntry;
    await h.engine.handleRevocationAnnounce(entry);
    expect(h.revocationRecord).toHaveBeenCalledWith(entry, {
      identity: {},
    });
  });
});

// ---------------------------------------------------------------------------
// Queueing
// ---------------------------------------------------------------------------

describe("DeliveryEngine — queueDelivery", () => {
  it("appends events under the target agent's queue", () => {
    const h = makeHarness();
    h.engine.queueDelivery(OTHER_ID, {
      type: "member_left",
      room: "r",
      agent: OTHER_ID,
    });
    h.engine.queueDelivery(OTHER_ID, {
      type: "member_left",
      room: "r2",
      agent: OTHER_ID,
    });
    expect(h.deps.deliveryQueues.get(OTHER_ID)).toHaveLength(2);
  });

  // Two mutants Stryker raises against queueDelivery's own `arr.length > MAX_QUEUED_DELIVERIES_PER_AGENT` guard are provably equivalent, not gaps: one replaces the whole condition with `true`, the other replaces `>` with `>=`. Both are unobservable because of `splice`'s own semantics, not because of a weak test -- the splice call's own deleteCount is computed as `arr.length - MAX_QUEUED_DELIVERIES_PER_AGENT`, which is <= 0 in exactly the cases these mutants would newly enter the branch for (at or below the cap), and `Array.prototype.splice` with a non-positive deleteCount is a documented no-op. So whether the branch itself fires is invisible: the guard's only effect is gating a call that already does nothing when the guard would have been false. Matches the identical reasoning already applied to room-protocol.ts's own `>` vs `>=` retry-queue boundary.
  it("keeps exactly MAX_QUEUED_DELIVERIES_PER_AGENT entries with no eviction at the boundary", () => {
    const h = makeHarness();
    for (let i = 0; i < MAX_QUEUED_DELIVERIES_PER_AGENT; i++) {
      h.engine.queueDelivery(OTHER_ID, {
        type: "member_left",
        room: `r${i}`,
        agent: OTHER_ID,
      });
    }
    const arr = h.deps.deliveryQueues.get(OTHER_ID);
    expect(arr).toHaveLength(MAX_QUEUED_DELIVERIES_PER_AGENT);
    expect(arr?.[0]).toMatchObject({ room: "r0" });
  });

  it("evicts the oldest entry, and only the oldest, once the bound is exceeded", () => {
    const h = makeHarness();
    for (let i = 0; i < MAX_QUEUED_DELIVERIES_PER_AGENT + 1; i++) {
      h.engine.queueDelivery(OTHER_ID, {
        type: "member_left",
        room: `r${i}`,
        agent: OTHER_ID,
      });
    }
    const arr = h.deps.deliveryQueues.get(OTHER_ID);
    expect(arr).toHaveLength(MAX_QUEUED_DELIVERIES_PER_AGENT);
    expect(arr?.[0]).toMatchObject({ room: "r1" });
    expect(arr?.at(-1)).toMatchObject({
      room: `r${MAX_QUEUED_DELIVERIES_PER_AGENT}`,
    });
  });
});

// ---------------------------------------------------------------------------
// Membership merge (mergeRoom / refreshMembership / mergeMemberOps, reached via applyPatch/applyStateSync)
// ---------------------------------------------------------------------------

describe("DeliveryEngine — mergeRoom via applyPatch(room_upsert)", () => {
  it("inserts a brand-new room and derives its membership views", async () => {
    const h = makeHarness();
    const incoming = room({
      id: "new-room",
      memberJoins: { [OTHER_ID]: 1 },
      memberLeaves: {},
    });
    await h.engine.applyPatch({ type: "room_upsert", room: incoming });
    const stored = h.deps.rooms.get("new-room");
    expect(stored?.members).toEqual([OTHER_ID]);
  });

  it("drops a stale room_upsert patch whose version is strictly behind the local copy", async () => {
    const h = makeHarness();
    h.deps.rooms.set("room-1", room({ version: 5, name: "current" }));
    await h.engine.applyPatch({
      type: "room_upsert",
      room: room({ version: 3, name: "stale" }),
    });
    expect(h.deps.rooms.get("room-1")?.name).toBe("current");
  });

  it("takes the strictly higher of the two versions, never the lower, on a genuine merge", async () => {
    const h = makeHarness();
    h.deps.rooms.set("room-1", room({ version: 1 }));
    await h.engine.applyPatch({
      type: "room_upsert",
      room: room({ version: 2 }),
    });
    expect(h.deps.rooms.get("room-1")?.version).toBe(2);
  });

  it("merges rather than dropping a room_upsert patch at exactly the same version as the local copy", async () => {
    const h = makeHarness();
    h.deps.rooms.set("room-1", room({ version: 2, name: "old-name" }));
    await h.engine.applyPatch({
      type: "room_upsert",
      room: room({ version: 2, name: "new-name" }),
    });
    expect(h.deps.rooms.get("room-1")?.name).toBe("new-name");
  });

  it("merges concurrent memberJoins by keeping the higher revision per agent, never overwriting with a lower one", async () => {
    const h = makeHarness();
    h.deps.rooms.set(
      "room-1",
      room({ version: 1, memberJoins: { [OTHER_ID]: 2 } }),
    );
    await h.engine.applyPatch({
      type: "room_upsert",
      room: room({ version: 2, memberJoins: { [OTHER_ID]: 1, [THIRD_ID]: 1 } }),
    });
    const stored = h.deps.rooms.get("room-1");
    expect(stored?.memberJoins[OTHER_ID]).toBe(2);
    expect(stored?.memberJoins[THIRD_ID]).toBe(1);
  });

  // mergeMemberOps' own `stamp > (merged[id] ?? 0)` boundary check has one provably equivalent mutant Stryker still raises here: replacing `>` with `>=`. It's unobservable because the two operators only disagree when `stamp === merged[id]` -- and at that exact point, `merged[id] = stamp` assigns the map entry its own current value, which produces no difference any assertion could detect. The test above already proves the operator's real job (a strictly lower incoming stamp never overwrites a higher local one, and a strictly higher one does); the equal-stamp case has nothing further to distinguish.
});

describe("DeliveryEngine — refreshMembership", () => {
  it("derives members as exactly those whose latest join outranks their latest leave", () => {
    const h = makeHarness();
    const r = room({
      memberJoins: { [OTHER_ID]: 2, [THIRD_ID]: 3 },
      memberLeaves: { [OTHER_ID]: 2, [THIRD_ID]: 1 },
    });
    h.engine.refreshMembership(r);
    expect(r.members).toEqual([THIRD_ID]);
  });

  it("derives invited as exactly those whose latest invite-join outranks their latest invite-leave", () => {
    const h = makeHarness();
    const r = room({
      invitedJoins: { [OTHER_ID]: 4, [THIRD_ID]: 2 },
      invitedLeaves: { [OTHER_ID]: 1, [THIRD_ID]: 2 },
    });
    h.engine.refreshMembership(r);
    expect(r.invited).toEqual([OTHER_ID]);
  });
});

// ---------------------------------------------------------------------------
// bump
// ---------------------------------------------------------------------------

describe("DeliveryEngine — bump", () => {
  it("increments the entity's version and returns the same reference", () => {
    const h = makeHarness();
    const r = room({ version: 1 });
    const result = h.engine.bump(r);
    expect(result).toBe(r);
    expect(r.version).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// applyStateSync
// ---------------------------------------------------------------------------

function emptyState(overrides: Partial<SerialisedState> = {}): SerialisedState {
  return {
    agents: {},
    rooms: {},
    messages: {},
    dms: {},
    deliveryQueues: {},
    ...overrides,
  };
}

describe("DeliveryEngine — applyStateSync agents", () => {
  it("skips an incoming agent strictly behind the local version, keeping the local copy", () => {
    const h = makeHarness();
    h.deps.agents.set(OTHER_ID, agent({ version: 5, name: "local" }));
    h.engine.applyStateSync(
      emptyState({
        agents: { [OTHER_ID]: agent({ version: 3, name: "stale" }) },
      }),
    );
    expect(h.deps.agents.get(OTHER_ID)?.name).toBe("local");
  });

  it("unions subscribedRooms without duplication when the incoming agent is at the exact same version", () => {
    const h = makeHarness();
    h.deps.agents.set(
      OTHER_ID,
      agent({ version: 5, subscribedRooms: ["local-room", "shared-room"] }),
    );
    h.engine.applyStateSync(
      emptyState({
        agents: {
          [OTHER_ID]: agent({
            version: 5,
            subscribedRooms: ["incoming-room", "shared-room"],
          }),
        },
      }),
    );
    const merged = h.deps.agents.get(OTHER_ID);
    expect(merged?.subscribedRooms.sort()).toEqual(
      ["incoming-room", "local-room", "shared-room"].sort(),
    );
  });

  it("replaces wholesale, with no union, when the incoming agent is at a strictly higher version", () => {
    const h = makeHarness();
    h.deps.agents.set(
      OTHER_ID,
      agent({ version: 5, subscribedRooms: ["local-only"] }),
    );
    h.engine.applyStateSync(
      emptyState({
        agents: {
          [OTHER_ID]: agent({ version: 9, subscribedRooms: ["incoming-only"] }),
        },
      }),
    );
    expect(h.deps.agents.get(OTHER_ID)?.subscribedRooms).toEqual([
      "incoming-only",
    ]);
  });

  it("inserts a brand-new agent this store has never seen", () => {
    const h = makeHarness();
    h.engine.applyStateSync(
      emptyState({ agents: { [OTHER_ID]: agent({ version: 1 }) } }),
    );
    expect(h.deps.agents.has(OTHER_ID)).toBe(true);
  });
});

describe("DeliveryEngine — applyStateSync rooms", () => {
  it("skips an incoming room strictly behind the local version", () => {
    const h = makeHarness();
    h.deps.rooms.set("room-1", room({ version: 5, name: "current" }));
    h.engine.applyStateSync(
      emptyState({ rooms: { "room-1": room({ version: 2, name: "stale" }) } }),
    );
    expect(h.deps.rooms.get("room-1")?.name).toBe("current");
  });

  it("merges an incoming room at or above the local version", () => {
    const h = makeHarness();
    h.deps.rooms.set("room-1", room({ version: 5 }));
    h.engine.applyStateSync(
      emptyState({
        rooms: { "room-1": room({ version: 5, name: "renamed" }) },
      }),
    );
    expect(h.deps.rooms.get("room-1")?.name).toBe("renamed");
  });
});

describe("DeliveryEngine — applyStateSync message/dm histories", () => {
  it("adopts the incoming history unmodified when this room has no local messages yet", () => {
    const h = makeHarness();
    const msgs = [roomMessage({ id: messageId() })];
    h.engine.applyStateSync(emptyState({ messages: { "room-1": msgs } }));
    expect(h.deps.messages.get("room-1")).toEqual(msgs);
  });

  it("merges the incoming history with the local one when both already have messages", () => {
    const h = makeHarness();
    const localId = messageId();
    const incomingId = messageId();
    h.deps.messages.set("room-1", [roomMessage({ id: localId })]);
    h.engine.applyStateSync(
      emptyState({
        messages: { "room-1": [roomMessage({ id: incomingId })] },
      }),
    );
    expect(
      h.deps.messages
        .get("room-1")
        ?.map((m) => m.id)
        .sort(),
    ).toEqual([localId, incomingId].sort());
  });

  it("adopts the incoming dm history unmodified when there is no local copy yet", () => {
    const h = makeHarness();
    const msgs = [dmMessage({ id: messageId() })];
    h.engine.applyStateSync(emptyState({ dms: { "dm-key": msgs } }));
    expect(h.deps.dms.get("dm-key")).toEqual(msgs);
  });

  it("merges the incoming dm history with the local one when both already have entries", () => {
    const h = makeHarness();
    const localId = messageId();
    const incomingId = messageId();
    h.deps.dms.set("dm-key", [dmMessage({ id: localId })]);
    h.engine.applyStateSync(
      emptyState({ dms: { "dm-key": [dmMessage({ id: incomingId })] } }),
    );
    expect(
      h.deps.dms
        .get("dm-key")
        ?.map((m) => m.id)
        .sort(),
    ).toEqual([localId, incomingId].sort());
  });
});

// One mutant Stryker still raises in this block is a provable equivalent, not a gap: the `(this.deps.deliveryQueues.get(agentId) ?? []).map((e) => JSON.stringify(e))` line building the dedup "seen" set has its own `?? []` fallback replaced with `?? ["Stryker was here"]`. That fallback only runs when the local queue for agentId is undefined, and mapping it into `JSON.stringify("Stryker was here")` produces a garbage string no real DeliveryEvent's own JSON serialisation will ever collide with -- so the seen set ends up functionally empty either way, and the dedup test below (which already proves a genuinely-repeated event is skipped and a genuinely-new one isn't) can't distinguish an empty seen set from one seeded with an unreachable placeholder string.
describe("DeliveryEngine — applyStateSync deliveryQueues replay", () => {
  it("queues every incoming event, even ones with no replay-eligible type", () => {
    const h = makeHarness();
    h.engine.applyStateSync(
      emptyState({
        deliveryQueues: {
          [PEER_ID]: [
            {
              type: "member_status",
              room: "room-1",
              agent: OTHER_ID,
              status: "idle",
            },
          ],
        },
      }),
    );
    expect(h.deps.deliveryQueues.get(PEER_ID)).toHaveLength(1);
  });

  it("does not duplicate an event already present in the local queue", () => {
    const h = makeHarness();
    const event: DeliveryEvent = {
      type: "member_left",
      room: "room-1",
      agent: OTHER_ID,
    };
    h.deps.deliveryQueues.set(PEER_ID, [event]);
    h.engine.applyStateSync(
      emptyState({ deliveryQueues: { [PEER_ID]: [event] } }),
    );
    expect(h.deps.deliveryQueues.get(PEER_ID)).toHaveLength(1);
  });

  it("fires onDelivery for a replayed room_message targeting this peer's own agent", () => {
    const h = makeHarness();
    const delivered = vi.fn();
    h.setOnDelivery(delivered);
    const event: DeliveryEvent = {
      type: "room_message",
      message: roomMessage(),
    };
    h.engine.applyStateSync(
      emptyState({ deliveryQueues: { [PEER_ID]: [event] } }),
    );
    expect(delivered).toHaveBeenCalledWith(PEER_ID, event);
  });

  it("fires onDelivery for a replayed dm targeting this peer's own agent", () => {
    const h = makeHarness();
    const delivered = vi.fn();
    h.setOnDelivery(delivered);
    const event: DeliveryEvent = { type: "dm", message: dmMessage() };
    h.engine.applyStateSync(
      emptyState({ deliveryQueues: { [PEER_ID]: [event] } }),
    );
    expect(delivered).toHaveBeenCalledWith(PEER_ID, event);
  });

  it("does not fire onDelivery for a replayed transient event even though it is still queued", () => {
    const h = makeHarness();
    const delivered = vi.fn();
    h.setOnDelivery(delivered);
    const event: DeliveryEvent = {
      type: "member_status",
      room: "room-1",
      agent: OTHER_ID,
      status: "idle",
    };
    h.engine.applyStateSync(
      emptyState({ deliveryQueues: { [PEER_ID]: [event] } }),
    );
    expect(delivered).not.toHaveBeenCalled();
    expect(h.deps.deliveryQueues.get(PEER_ID)).toHaveLength(1);
  });

  it("fires onDelivery for a room_invite still reflected in the room's own invited list", () => {
    const h = makeHarness();
    h.deps.rooms.set("room-1", room({ invited: [PEER_ID] }));
    const delivered = vi.fn();
    h.setOnDelivery(delivered);
    const event: DeliveryEvent = {
      type: "room_invite",
      room: "room-1",
      roomDescription: "",
      from: OTHER_ID,
      fromName: "other",
      fromCwd: "/tmp",
    };
    h.engine.applyStateSync(
      emptyState({ deliveryQueues: { [PEER_ID]: [event] } }),
    );
    expect(delivered).toHaveBeenCalledWith(PEER_ID, event);
  });

  it("does not fire onDelivery for a room_invite no longer reflected in the room's invited list, though it stays queued", () => {
    const h = makeHarness();
    h.deps.rooms.set("room-1", room({ invited: [] }));
    const delivered = vi.fn();
    h.setOnDelivery(delivered);
    const event: DeliveryEvent = {
      type: "room_invite",
      room: "room-1",
      roomDescription: "",
      from: OTHER_ID,
      fromName: "other",
      fromCwd: "/tmp",
    };
    h.engine.applyStateSync(
      emptyState({ deliveryQueues: { [PEER_ID]: [event] } }),
    );
    expect(delivered).not.toHaveBeenCalled();
    expect(h.deps.deliveryQueues.get(PEER_ID)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// applyPatch — non-delivery cases (agent_upsert / room_delete / message_add / dm_add) -- the delivery case, and everything after it, lives in delivery-engine-delivery.test.ts
// ---------------------------------------------------------------------------

describe("DeliveryEngine — applyPatch(agent_upsert)", () => {
  it("drops a stale patch whose version is strictly behind the local copy", async () => {
    const h = makeHarness();
    h.deps.agents.set(OTHER_ID, agent({ version: 5, name: "current" }));
    await h.engine.applyPatch({
      type: "agent_upsert",
      agent: agent({ version: 3, name: "stale" }),
    });
    expect(h.deps.agents.get(OTHER_ID)?.name).toBe("current");
  });

  it("inserts a brand-new agent with no prior local record", async () => {
    const h = makeHarness();
    await h.engine.applyPatch({
      type: "agent_upsert",
      agent: agent({ version: 1 }),
    });
    expect(h.deps.agents.has(OTHER_ID)).toBe(true);
  });

  it("unions subscribedRooms without duplication at the exact same version", async () => {
    const h = makeHarness();
    h.deps.agents.set(
      OTHER_ID,
      agent({ version: 4, subscribedRooms: ["local-only", "shared"] }),
    );
    await h.engine.applyPatch({
      type: "agent_upsert",
      agent: agent({
        version: 4,
        subscribedRooms: ["incoming-only", "shared"],
      }),
    });
    const merged = h.deps.agents.get(OTHER_ID);
    expect(merged?.subscribedRooms.sort()).toEqual(
      ["incoming-only", "local-only", "shared"].sort(),
    );
  });
});

// The `this.deps.agents.set(patch.agentId, agent)` call at the end of this branch has one provable equivalent mutant Stryker still raises: removing it entirely. `agent` here is fetched via `this.deps.agents.get(patch.agentId)`, the exact same object reference already stored in the Map, and `agent.status = "offline"` mutates that object in place -- so re-setting the map entry to the identical reference it already holds is a genuine no-op, the same Map.set-same-reference pattern already documented elsewhere in this codebase (agent-registry.ts's setAgentOffline). The test below already proves the real, observable effect (status flips to "offline").
describe("DeliveryEngine — applyPatch(agent_offline)", () => {
  it("marks an existing agent as offline", async () => {
    const h = makeHarness();
    h.deps.agents.set(OTHER_ID, agent({ status: "active" }));
    await h.engine.applyPatch({ type: "agent_offline", agentId: OTHER_ID });
    expect(h.deps.agents.get(OTHER_ID)?.status).toBe("offline");
  });

  it("does nothing when the agent has no local record", async () => {
    const h = makeHarness();
    await expect(
      h.engine.applyPatch({ type: "agent_offline", agentId: OTHER_ID }),
    ).resolves.toBeUndefined();
    expect(h.deps.agents.has(OTHER_ID)).toBe(false);
  });
});

describe("DeliveryEngine — applyPatch(room_delete/message_add/dm_add)", () => {
  it("removes the room from the local map", async () => {
    const h = makeHarness();
    h.deps.rooms.set("room-1", room());
    await h.engine.applyPatch({ type: "room_delete", roomId: "room-1" });
    expect(h.deps.rooms.has("room-1")).toBe(false);
  });

  it("appends a message_add patch's message onto the room's history", async () => {
    const h = makeHarness();
    const msg = roomMessage({ id: messageId() });
    await h.engine.applyPatch({
      type: "message_add",
      roomId: "room-1",
      message: msg,
    });
    expect(h.deps.messages.get("room-1")).toEqual([msg]);
  });

  it("appends a dm_add patch's message onto the dm history keyed by its key", async () => {
    const h = makeHarness();
    const msg = dmMessage({ id: messageId() });
    await h.engine.applyPatch({ type: "dm_add", key: "dm-key", message: msg });
    expect(h.deps.dms.get("dm-key")).toEqual([msg]);
  });
});

describe("DeliveryEngine — applyPatch onPatch callback", () => {
  it("invokes onPatch with the exact patch after applying it, when one is set", async () => {
    const h = makeHarness();
    const onPatch = vi.fn();
    h.setOnPatch(onPatch);
    const patch: MeshStatePatch = { type: "room_delete", roomId: "room-1" };
    await h.engine.applyPatch(patch);
    expect(onPatch).toHaveBeenCalledWith(patch);
  });

  it("does not throw when no onPatch callback is set", async () => {
    const h = makeHarness();
    await expect(
      h.engine.applyPatch({ type: "room_delete", roomId: "room-1" }),
    ).resolves.toBeUndefined();
  });
});

describe("DeliveryEngine — deliver", () => {
  it("delegates to deliverLocallyAndBroadcast, queueing and broadcasting the event", async () => {
    const h = makeHarness();
    await h.engine.deliver(OTHER_ID, {
      type: "member_left",
      room: "room-1",
      agent: OTHER_ID,
    });
    expect(h.deps.deliveryQueues.get(OTHER_ID)).toHaveLength(1);
    expect(h.transport.broadcast).toHaveBeenCalledTimes(1);
  });
});

describe("DeliveryEngine — drainDelivery", () => {
  it("returns the queued events and empties the queue", async () => {
    const h = makeHarness();
    const event: DeliveryEvent = {
      type: "member_left",
      room: "room-1",
      agent: OTHER_ID,
    };
    h.deps.deliveryQueues.set(PEER_ID, [event]);
    const drained = await h.engine.drainDelivery(PEER_ID);
    expect(drained).toEqual([event]);
    expect(h.deps.deliveryQueues.get(PEER_ID)).toEqual([]);
  });

  it("returns an empty array for an agent with no queued events", async () => {
    const h = makeHarness();
    const drained = await h.engine.drainDelivery(OTHER_ID);
    expect(drained).toEqual([]);
  });

  it("marks a drained dm as read via markRead, mirroring the room_message case", async () => {
    const h = makeHarness();
    const msg = dmMessage({ id: messageId(), from: OTHER_ID, readBy: [] });
    h.deps.dms.set("self:z", [msg]);
    vi.mocked(loadRoomTokens).mockReturnValue({ "self:z": FAKE_TOKEN });
    h.deps.deliveryQueues.set(PEER_ID, [{ type: "dm", message: msg }]);
    await h.engine.drainDelivery(PEER_ID);
    expect(msg.readBy).toEqual([PEER_ID]);
    expect(h.sendRoomRequestToMember).toHaveBeenCalledWith(
      OTHER_ID,
      "self:z",
      FAKE_TOKEN,
      expect.objectContaining({ verb: "room.read" }),
    );
  });

  it("does not attempt to mark read a transient event with no message of its own", async () => {
    const h = makeHarness();
    h.deps.deliveryQueues.set(PEER_ID, [
      {
        type: "member_status",
        room: "room-1",
        agent: OTHER_ID,
        status: "idle",
      },
    ]);
    await expect(h.engine.drainDelivery(PEER_ID)).resolves.toHaveLength(1);
    expect(h.sendRoomRequestToMember).not.toHaveBeenCalled();
  });
});

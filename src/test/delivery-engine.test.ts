/**
 * Direct, DI-based unit tests for DeliveryEngine -- the busiest collaborator in mesh-store.ts's own split (see its file header), previously exercised only indirectly through end-to-end room-send/state-sync integration tests, leaving many individual branches (version-gate boundaries, subscribedRooms union-vs-replace, dedup caps, timer-scheduled auto-mark-read, replay's per-type fire rules) unobserved. DeliveryEngineDeps is a narrow, injectable surface built exactly for this: every Map/Set is a real instance so effects are asserted by inspecting them directly, and every collaborator boundary (transport, sendRoomRequestToMember, onDelivery/onPatch callbacks, isShutDown) is a vi.fn() this file controls per test. loadRoomTokens is a free function reading a real identity file, not part of the injectable deps -- mocked here since markRead only ever forwards its return value opaquely, never inspects or verifies it. Split from delivery-engine-delivery.test.ts to satisfy the repo's max-lines cap: this file covers the presence/queueing/membership-merge/state-sync/patch-application half; delivery-engine-delivery.test.ts covers the local-delivery/broadcast/notification/mark-read half. Both files share an identical preamble (helpers, fakes, makeHarness) by necessity of the split.
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

  it("retains the existing federated flag when the incoming room leaves it undefined", async () => {
    const h = makeHarness();
    h.deps.rooms.set("room-1", room({ version: 1, federated: true }));
    const incoming = room({ version: 2 });
    delete incoming.federated;
    await h.engine.applyPatch({ type: "room_upsert", room: incoming });
    expect(h.deps.rooms.get("room-1")?.federated).toBe(true);
  });

  it("overwrites the federated flag when the incoming room states it explicitly, including false", async () => {
    const h = makeHarness();
    h.deps.rooms.set("room-1", room({ version: 1, federated: true }));
    await h.engine.applyPatch({
      type: "room_upsert",
      room: room({ version: 2, federated: false }),
    });
    expect(h.deps.rooms.get("room-1")?.federated).toBe(false);
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

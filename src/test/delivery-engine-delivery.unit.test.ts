/**
 * Direct, DI-based unit tests for DeliveryEngine's delivery/broadcast/notification half -- applyPatch's "delivery" case, broadcastPatch, deliverLocallyAndBroadcast, fireLocalDelivery, deliverToRoom, notifyRoomsOfStatus/NameChange, emitDeliveryStatus, markRead, deliver, and drainDelivery. Split from delivery-engine.test.ts to satisfy the repo's max-lines cap: that file covers the presence/queueing/membership-merge/state-sync/patch-application half. Both files share an identical preamble (helpers, fakes, makeHarness) by necessity of the split -- see delivery-engine.test.ts's own header for the full rationale.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRoomTokens } from "../core/identity-store.js";
import { randomId } from "../core/random-id.js";
import {
  DeliveryEngine,
  type DeliveryEngineDeps,
} from "../core/delivery-engine.js";
import type { MeshTransport } from "../core/transport.js";
import type { MeshStatePatch } from "../core/wire-protocol.js";
import type {
  AgentIdentity,
  DeliveryEvent,
  DmMessage,
  Room,
  RoomMessage,
} from "../core/types.js";
import type { CapabilityToken } from "wire-mesh-core/generated/protocol";
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

describe("DeliveryEngine — applyPatch(delivery)", () => {
  it("queues the event for the target agent regardless of who it targets", async () => {
    const h = makeHarness();
    await h.engine.applyPatch({
      type: "delivery",
      agentId: OTHER_ID,
      event: { type: "member_left", room: "room-1", agent: OTHER_ID },
    });
    expect(h.deps.deliveryQueues.get(OTHER_ID)).toHaveLength(1);
  });

  it("does not fire onDelivery for a patch targeting a different agent than this peer", async () => {
    const h = makeHarness();
    const delivered = vi.fn();
    h.setOnDelivery(delivered);
    await h.engine.applyPatch({
      type: "delivery",
      agentId: OTHER_ID,
      event: { type: "member_left", room: "room-1", agent: OTHER_ID },
    });
    expect(delivered).not.toHaveBeenCalled();
  });

  it("fires onDelivery for a patch targeting this peer's own agent", async () => {
    const h = makeHarness();
    const delivered = vi.fn();
    h.setOnDelivery(delivered);
    const event: DeliveryEvent = {
      type: "room_message",
      message: roomMessage(),
    };
    await h.engine.applyPatch({ type: "delivery", agentId: PEER_ID, event });
    expect(delivered).toHaveBeenCalledWith(PEER_ID, event);
  });

  it("dedupes against a delivery already fired in this process, never calling onDelivery twice for it", async () => {
    const h = makeHarness();
    const delivered = vi.fn();
    h.setOnDelivery(delivered);
    const event: DeliveryEvent = {
      type: "room_message",
      message: roomMessage(),
    };
    await h.engine.applyPatch({ type: "delivery", agentId: PEER_ID, event });
    await h.engine.applyPatch({ type: "delivery", agentId: PEER_ID, event });
    expect(delivered).toHaveBeenCalledTimes(1);
  });

  it("evicts the oldest local-delivery dedup key once the cap is exceeded", async () => {
    const h = makeHarness();
    h.setOnDelivery(vi.fn());
    for (let i = 0; i < MAX_LOCAL_DELIVERY_DEDUP_KEYS + 1; i++) {
      await h.engine.applyPatch({
        type: "delivery",
        agentId: PEER_ID,
        event: {
          type: "room_message",
          message: roomMessage({ content: `m${i}` }),
        },
      });
    }
    expect(h.deps.localDeliveryKeys.size).toBe(MAX_LOCAL_DELIVERY_DEDUP_KEYS);
  });

  it("schedules a mark-read timer for a delivery targeting this peer, tracked in pendingMarkReadTimers", async () => {
    const h = makeHarness();
    h.setOnDelivery(vi.fn());
    await h.engine.applyPatch({
      type: "delivery",
      agentId: PEER_ID,
      event: { type: "room_message", message: roomMessage() },
    });
    expect(h.deps.pendingMarkReadTimers).toHaveLength(1);
  });

  it("does not schedule a mark-read timer once the store is already shut down", async () => {
    const h = makeHarness();
    h.setOnDelivery(vi.fn());
    h.setShutDown(true);
    await h.engine.applyPatch({
      type: "delivery",
      agentId: PEER_ID,
      event: { type: "room_message", message: roomMessage() },
    });
    expect(h.deps.pendingMarkReadTimers).toHaveLength(0);
  });

  it("skips the scheduled mark-read work if the store is shut down by the time the timer fires", async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      h.setOnDelivery(vi.fn());
      vi.mocked(loadRoomTokens).mockReturnValue({ "room-1": FAKE_TOKEN });
      const msg = roomMessage({ from: OTHER_ID });
      h.deps.messages.set("room-1", [msg]);
      await h.engine.applyPatch({
        type: "delivery",
        agentId: PEER_ID,
        event: { type: "room_message", message: msg },
      });
      h.setShutDown(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.sendRoomRequestToMember).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs the scheduled mark-read work for a room_message when not shut down", async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      h.setOnDelivery(vi.fn());
      const msg = roomMessage({ from: OTHER_ID, id: messageId() });
      h.deps.messages.set("room-1", [msg]);
      await h.engine.applyPatch({
        type: "delivery",
        agentId: PEER_ID,
        event: { type: "room_message", message: msg },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(h.sendRoomRequestToMember).toHaveBeenCalledWith(
        OTHER_ID,
        "room-1",
        FAKE_TOKEN,
        expect.objectContaining({ verb: "room.read" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs the scheduled mark-read work for a dm when not shut down", async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      h.setOnDelivery(vi.fn());
      const key = "self:x";
      const msg = dmMessage({ from: OTHER_ID, id: messageId() });
      h.deps.dms.set(key, [msg]);
      vi.mocked(loadRoomTokens).mockReturnValue({ [key]: FAKE_TOKEN });
      await h.engine.applyPatch({
        type: "delivery",
        agentId: PEER_ID,
        event: { type: "dm", message: msg },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(h.sendRoomRequestToMember).toHaveBeenCalledWith(
        OTHER_ID,
        key,
        FAKE_TOKEN,
        expect.objectContaining({ verb: "room.read" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// broadcastPatch
// ---------------------------------------------------------------------------

describe("DeliveryEngine — broadcastPatch", () => {
  it("broadcasts a state_update message over the transport and invokes onPatch", async () => {
    const h = makeHarness();
    const onPatch = vi.fn();
    h.setOnPatch(onPatch);
    const patch: MeshStatePatch = { type: "room_delete", roomId: "room-1" };
    await h.engine.broadcastPatch(patch);
    expect(h.transport.broadcast).toHaveBeenCalledWith({
      method: "state_update",
      patch,
    });
    expect(onPatch).toHaveBeenCalledWith(patch);
  });
});

// ---------------------------------------------------------------------------
// deliverLocallyAndBroadcast / fireLocalDelivery
// ---------------------------------------------------------------------------

describe("DeliveryEngine — deliverLocallyAndBroadcast", () => {
  it("emits a delivery_status(delivered) event back to the room message's own sender", async () => {
    const h = makeHarness();
    const sent = roomMessage({ from: PEER_ID, id: messageId() });
    h.deps.messages.set("room-1", [sent]);
    await h.engine.deliver(OTHER_ID, { type: "room_message", message: sent });
    const senderQueue = h.deps.deliveryQueues.get(PEER_ID);
    expect(senderQueue).toContainEqual(
      expect.objectContaining({
        type: "delivery_status",
        messageId: sent.id,
        agent: OTHER_ID,
        delivery: { status: "delivered" },
      }),
    );
  });

  it("emits a delivery_status(delivered) event back to a dm's own sender", async () => {
    const h = makeHarness();
    const sent = dmMessage({ from: PEER_ID, id: messageId() });
    h.deps.dms.set("self:x", [sent]);
    await h.engine.deliver(OTHER_ID, { type: "dm", message: sent });
    const senderQueue = h.deps.deliveryQueues.get(PEER_ID);
    expect(senderQueue).toContainEqual(
      expect.objectContaining({
        type: "delivery_status",
        messageId: sent.id,
        agent: OTHER_ID,
        delivery: { status: "delivered" },
      }),
    );
  });

  it("broadcasts the delivery over the transport", async () => {
    const h = makeHarness();
    await h.engine.deliver(OTHER_ID, {
      type: "member_left",
      room: "room-1",
      agent: OTHER_ID,
    });
    expect(h.transport.broadcast).toHaveBeenCalledWith({
      method: "state_update",
      patch: {
        type: "delivery",
        agentId: OTHER_ID,
        event: { type: "member_left", room: "room-1", agent: OTHER_ID },
      },
    });
  });
});

describe("DeliveryEngine — fireLocalDelivery", () => {
  it("does nothing when the event does not target this peer's own agent", () => {
    const h = makeHarness();
    const delivered = vi.fn();
    h.setOnDelivery(delivered);
    h.engine.fireLocalDelivery(OTHER_ID, {
      type: "member_left",
      room: "room-1",
      agent: OTHER_ID,
    });
    expect(delivered).not.toHaveBeenCalled();
  });

  it("does nothing when no onDelivery callback is set", () => {
    const h = makeHarness();
    h.engine.fireLocalDelivery(PEER_ID, {
      type: "member_left",
      room: "room-1",
      agent: PEER_ID,
    });
    // No throw is the assertion: there is no onDelivery to have been called.
  });

  it("skips a room_message this agent has already read", () => {
    const h = makeHarness();
    const delivered = vi.fn();
    h.setOnDelivery(delivered);
    const msg = roomMessage({ readBy: [PEER_ID] });
    h.engine.fireLocalDelivery(PEER_ID, {
      type: "room_message",
      message: msg,
    });
    expect(delivered).not.toHaveBeenCalled();
  });

  it("skips a dm this agent has already read", () => {
    const h = makeHarness();
    const delivered = vi.fn();
    h.setOnDelivery(delivered);
    const msg = dmMessage({ readBy: [PEER_ID] });
    h.engine.fireLocalDelivery(PEER_ID, { type: "dm", message: msg });
    expect(delivered).not.toHaveBeenCalled();
  });

  it("fires for a room_message this agent has not yet read", () => {
    const h = makeHarness();
    const delivered = vi.fn();
    h.setOnDelivery(delivered);
    const msg = roomMessage({ readBy: [] });
    h.engine.fireLocalDelivery(PEER_ID, {
      type: "room_message",
      message: msg,
    });
    expect(delivered).toHaveBeenCalledTimes(1);
  });

  it("dedupes against the identical event already fired once in this process", () => {
    const h = makeHarness();
    const delivered = vi.fn();
    h.setOnDelivery(delivered);
    const event: DeliveryEvent = {
      type: "member_left",
      room: "room-1",
      agent: PEER_ID,
    };
    h.engine.fireLocalDelivery(PEER_ID, event);
    h.engine.fireLocalDelivery(PEER_ID, event);
    expect(delivered).toHaveBeenCalledTimes(1);
  });

  it("evicts the oldest dedup key once the cap is exceeded", () => {
    const h = makeHarness();
    h.setOnDelivery(vi.fn());
    for (let i = 0; i < MAX_LOCAL_DELIVERY_DEDUP_KEYS + 1; i++) {
      h.engine.fireLocalDelivery(PEER_ID, {
        type: "member_left",
        room: `r${i}`,
        agent: PEER_ID,
      });
    }
    expect(h.deps.localDeliveryKeys.size).toBe(MAX_LOCAL_DELIVERY_DEDUP_KEYS);
  });

  it("removes exactly the delivered event from the pending queue, leaving other entries untouched", () => {
    const h = makeHarness();
    h.setOnDelivery(vi.fn());
    const eventA: DeliveryEvent = {
      type: "member_left",
      room: "room-a",
      agent: PEER_ID,
    };
    const eventB: DeliveryEvent = {
      type: "member_left",
      room: "room-b",
      agent: PEER_ID,
    };
    h.deps.deliveryQueues.set(PEER_ID, [eventA, eventB]);
    h.engine.fireLocalDelivery(PEER_ID, eventB);
    expect(h.deps.deliveryQueues.get(PEER_ID)).toEqual([eventA]);
  });

  it("leaves the queue untouched when the fired event isn't present in it", () => {
    const h = makeHarness();
    h.setOnDelivery(vi.fn());
    const eventA: DeliveryEvent = {
      type: "member_left",
      room: "room-a",
      agent: PEER_ID,
    };
    h.deps.deliveryQueues.set(PEER_ID, [eventA]);
    h.engine.fireLocalDelivery(PEER_ID, {
      type: "member_left",
      room: "not-queued",
      agent: PEER_ID,
    });
    expect(h.deps.deliveryQueues.get(PEER_ID)).toEqual([eventA]);
  });

  it("schedules a mark-read timer, tracked in pendingMarkReadTimers, when not shut down", () => {
    const h = makeHarness();
    h.setOnDelivery(vi.fn());
    h.engine.fireLocalDelivery(PEER_ID, {
      type: "room_message",
      message: roomMessage(),
    });
    expect(h.deps.pendingMarkReadTimers).toHaveLength(1);
  });

  it("does not schedule a mark-read timer once already shut down", () => {
    const h = makeHarness();
    h.setOnDelivery(vi.fn());
    h.setShutDown(true);
    h.engine.fireLocalDelivery(PEER_ID, {
      type: "room_message",
      message: roomMessage(),
    });
    expect(h.deps.pendingMarkReadTimers).toHaveLength(0);
  });

  it("runs the scheduled mark-read work for a dm via fireLocalDelivery when not shut down", async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      h.setOnDelivery(vi.fn());
      const key = "self:y";
      const msg = dmMessage({ from: OTHER_ID, id: messageId() });
      h.deps.dms.set(key, [msg]);
      vi.mocked(loadRoomTokens).mockReturnValue({ [key]: FAKE_TOKEN });
      h.engine.fireLocalDelivery(PEER_ID, { type: "dm", message: msg });
      await vi.advanceTimersByTimeAsync(0);
      expect(h.sendRoomRequestToMember).toHaveBeenCalledWith(
        OTHER_ID,
        key,
        FAKE_TOKEN,
        expect.objectContaining({ verb: "room.read" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips the scheduled mark-read work via fireLocalDelivery if the store is shut down by the time the timer fires", async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      h.setOnDelivery(vi.fn());
      const msg = roomMessage({ from: OTHER_ID, id: messageId() });
      h.deps.messages.set("room-1", [msg]);
      h.engine.fireLocalDelivery(PEER_ID, {
        type: "room_message",
        message: msg,
      });
      h.setShutDown(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.sendRoomRequestToMember).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// deliverToRoom / notifyRoomsOfStatus / notifyRoomsOfNameChange
// ---------------------------------------------------------------------------

describe("DeliveryEngine — notifyRoomsOfStatus", () => {
  it("does nothing for an agent with no known record", async () => {
    const h = makeHarness();
    await expect(
      h.engine.notifyRoomsOfStatus(OTHER_ID, "idle"),
    ).resolves.toBeUndefined();
  });

  it("delivers a member_status event to every one of the agent's subscribed rooms", async () => {
    const h = makeHarness();
    h.deps.agents.set(
      OTHER_ID,
      agent({ subscribedRooms: ["room-a", "room-b"] }),
    );
    h.deps.rooms.set("room-a", room({ id: "room-a", members: [PEER_ID] }));
    h.deps.rooms.set("room-b", room({ id: "room-b", members: [THIRD_ID] }));
    await h.engine.notifyRoomsOfStatus(OTHER_ID, "busy");
    expect(h.deps.deliveryQueues.get(PEER_ID)).toContainEqual(
      expect.objectContaining({
        type: "member_status",
        room: "room-a",
        agent: OTHER_ID,
        status: "busy",
      }),
    );
    expect(h.deps.deliveryQueues.get(THIRD_ID)).toContainEqual(
      expect.objectContaining({
        type: "member_status",
        room: "room-b",
        agent: OTHER_ID,
        status: "busy",
      }),
    );
  });
});

describe("DeliveryEngine — notifyRoomsOfNameChange", () => {
  it("does nothing for an agent with no known record", async () => {
    const h = makeHarness();
    await expect(
      h.engine.notifyRoomsOfNameChange(OTHER_ID, "old", "new"),
    ).resolves.toBeUndefined();
  });

  it("notifies other room members and the agent itself exactly once each", async () => {
    const h = makeHarness();
    h.deps.agents.set(OTHER_ID, agent({ subscribedRooms: ["room-a"] }));
    h.deps.rooms.set(
      "room-a",
      room({ id: "room-a", members: [PEER_ID, OTHER_ID] }),
    );
    await h.engine.notifyRoomsOfNameChange(OTHER_ID, "old-name", "new-name");
    const peerQueue = h.deps.deliveryQueues.get(PEER_ID) ?? [];
    const selfQueue = h.deps.deliveryQueues.get(OTHER_ID) ?? [];
    expect(peerQueue.filter((e) => e.type === "name_changed")).toHaveLength(1);
    expect(selfQueue.filter((e) => e.type === "name_changed")).toHaveLength(1);
  });

  // Remote-agent directed-notify cases for notifyRoomsOfNameChange's own trailing self/DM-path delivery live in delivery-engine-directed-notify.test.ts, alongside deliverToRoom's and emitDeliveryStatus's own directed cases, to stay under this file's own max-lines budget.
});

// ---------------------------------------------------------------------------
// emitDeliveryStatus / findMessageSender / findMessageLocation (private, reached via public callers already exercised above; direct edge cases below)
// ---------------------------------------------------------------------------

describe("DeliveryEngine — emitDeliveryStatus via deliverLocallyAndBroadcast", () => {
  it("emits nothing when the message's sender cannot be found anywhere", async () => {
    const h = makeHarness();
    const orphanMessage = roomMessage({ id: messageId() });
    // Deliberately not stored in h.deps.messages, so findMessageSender returns undefined.
    await expect(
      h.engine.deliver(OTHER_ID, {
        type: "room_message",
        message: orphanMessage,
      }),
    ).resolves.toBeUndefined();
    expect(h.deps.deliveryQueues.size).toBe(1);
    expect(h.deps.deliveryQueues.get(OTHER_ID)).toHaveLength(1);
  });

  it("finds the room message's sender by exact id match among several messages in the same room", async () => {
    const h = makeHarness();
    const target = roomMessage({ id: messageId(), from: PEER_ID });
    h.deps.messages.set("room-1", [
      roomMessage({ id: messageId(), from: THIRD_ID }),
      target,
    ]);
    await h.engine.deliver(OTHER_ID, {
      type: "room_message",
      message: target,
    });
    expect(h.deps.deliveryQueues.get(PEER_ID)).toContainEqual(
      expect.objectContaining({
        type: "delivery_status",
        messageId: target.id,
      }),
    );
  });

  it("finds a dm's sender by searching across every dm history when no room is given", async () => {
    const h = makeHarness();
    const target = dmMessage({ id: messageId(), from: PEER_ID });
    h.deps.dms.set("self:other", [
      dmMessage({ id: messageId(), from: THIRD_ID }),
    ]);
    h.deps.dms.set("self:x", [target]);
    await h.engine.deliver(OTHER_ID, { type: "dm", message: target });
    expect(h.deps.deliveryQueues.get(PEER_ID)).toContainEqual(
      expect.objectContaining({
        type: "delivery_status",
        messageId: target.id,
      }),
    );
  });

  // Remote-sender directed-notify cases for emitDeliveryStatus live in delivery-engine-directed-notify.test.ts, alongside deliverToRoom's and notifyRoomsOfNameChange's own directed cases, to stay under this file's own max-lines budget.
});

// ---------------------------------------------------------------------------
// markRead (private, reached only via drainDelivery/fireLocalDelivery/applyPatch's timer -- direct edge cases below via drainDelivery, which awaits it synchronously with no timer indirection)
// ---------------------------------------------------------------------------

describe("DeliveryEngine — markRead via drainDelivery", () => {
  it("adds the reader to readBy without duplicating an already-present entry", async () => {
    const h = makeHarness();
    const msg = roomMessage({
      id: messageId(),
      from: OTHER_ID,
      readBy: [PEER_ID],
    });
    h.deps.messages.set("room-1", [msg]);
    h.deps.deliveryQueues.set(PEER_ID, [
      { type: "room_message", message: msg },
    ]);
    await h.engine.drainDelivery(PEER_ID);
    expect(msg.readBy).toEqual([PEER_ID]);
  });

  it("pushes the reader onto readBy when not already present", async () => {
    const h = makeHarness();
    const msg = roomMessage({ id: messageId(), from: OTHER_ID, readBy: [] });
    h.deps.messages.set("room-1", [msg]);
    h.deps.deliveryQueues.set(PEER_ID, [
      { type: "room_message", message: msg },
    ]);
    await h.engine.drainDelivery(PEER_ID);
    expect(msg.readBy).toEqual([PEER_ID]);
  });

  it("finds the exact target room message by id among several others in the same room, not merely the first", async () => {
    const h = makeHarness();
    const target = roomMessage({ id: messageId(), from: OTHER_ID, readBy: [] });
    h.deps.messages.set("room-1", [
      roomMessage({ id: messageId(), from: THIRD_ID }),
      target,
    ]);
    h.deps.deliveryQueues.set(PEER_ID, [
      { type: "room_message", message: target },
    ]);
    await h.engine.drainDelivery(PEER_ID);
    expect(target.readBy).toEqual([PEER_ID]);
    expect(h.sendRoomRequestToMember).toHaveBeenCalledWith(
      OTHER_ID,
      "room-1",
      FAKE_TOKEN,
      expect.objectContaining({ verb: "room.read" }),
    );
  });

  it("finds the exact target dm by id among several others in the same dm history, not merely the first", async () => {
    const h = makeHarness();
    const dmKey = "self:multi";
    const target = dmMessage({ id: messageId(), from: OTHER_ID, readBy: [] });
    h.deps.dms.set(dmKey, [
      dmMessage({ id: messageId(), from: THIRD_ID }),
      target,
    ]);
    vi.mocked(loadRoomTokens).mockReturnValue({ [dmKey]: FAKE_TOKEN });
    h.deps.deliveryQueues.set(PEER_ID, [{ type: "dm", message: target }]);
    await h.engine.drainDelivery(PEER_ID);
    expect(target.readBy).toEqual([PEER_ID]);
    expect(h.sendRoomRequestToMember).toHaveBeenCalledWith(
      OTHER_ID,
      dmKey,
      FAKE_TOKEN,
      expect.objectContaining({ verb: "room.read" }),
    );
  });

  it("does not notify the author when the reader marking read is the author themselves", async () => {
    const h = makeHarness();
    const msg = roomMessage({ id: messageId(), from: PEER_ID, readBy: [] });
    h.deps.messages.set("room-1", [msg]);
    h.deps.deliveryQueues.set(PEER_ID, [
      { type: "room_message", message: msg },
    ]);
    await h.engine.drainDelivery(PEER_ID);
    expect(h.sendRoomRequestToMember).not.toHaveBeenCalled();
  });

  it("sends a directed room.read request to the message's own author with the message id and current time", async () => {
    const h = makeHarness();
    const msg = roomMessage({ id: messageId(), from: OTHER_ID, readBy: [] });
    h.deps.messages.set("room-1", [msg]);
    h.deps.deliveryQueues.set(PEER_ID, [
      { type: "room_message", message: msg },
    ]);
    await h.engine.drainDelivery(PEER_ID);
    expect(h.sendRoomRequestToMember).toHaveBeenCalledWith(
      OTHER_ID,
      "room-1",
      FAKE_TOKEN,
      expect.objectContaining({ verb: "room.read", at: NOW_MS }),
    );
  });

  it("does nothing when no room:member token is persisted for the message's room", async () => {
    const h = makeHarness();
    vi.mocked(loadRoomTokens).mockReturnValue({});
    const msg = roomMessage({ id: messageId(), from: OTHER_ID, readBy: [] });
    h.deps.messages.set("room-1", [msg]);
    h.deps.deliveryQueues.set(PEER_ID, [
      { type: "room_message", message: msg },
    ]);
    await h.engine.drainDelivery(PEER_ID);
    expect(h.sendRoomRequestToMember).not.toHaveBeenCalled();
    // The local readBy update still happened -- read receipts are best-effort at the wire-notification step only.
    expect(msg.readBy).toEqual([PEER_ID]);
  });

  it("does nothing when the message cannot be located at all", async () => {
    const h = makeHarness();
    h.deps.deliveryQueues.set(PEER_ID, [
      { type: "room_message", message: roomMessage({ id: messageId() }) },
    ]);
    await expect(h.engine.drainDelivery(PEER_ID)).resolves.toBeDefined();
    expect(h.sendRoomRequestToMember).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  vi.useRealTimers();
});

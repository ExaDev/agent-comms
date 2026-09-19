/**
 * Direct, DI-based unit tests for DeliveryEngine's directed room.notify replacements (P3.8, agent-comms#48): deliverToRoom, notifyRoomsOfNameChange's own trailing self/DM-path delivery, and emitDeliveryStatus's own remote-sender delivery -- moved into its own file to stay under the repo's max-lines cap once delivery-engine.test.ts and delivery-engine-delivery.test.ts were already at capacity. Shares the same fake-harness convention those two files established: a narrow, injectable DeliveryEngineDeps surface with every collaborator boundary (transport, sendRoomRequestToMember, onDelivery/onPatch callbacks) a vi.fn() this file controls per test.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
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

// Opaque placeholder: deliverToRoom never inspects a token's own COSE_Sign1 structure, only forwards whatever loadRoomTokens returns to sendRoomRequestToMember.
const FAKE_TOKEN = "fake-token" as unknown as CapabilityToken;

/** A device-id is a 64-character lowercase hex SHA-256 digest; room-path.ts's assertDeviceIdHex rejects anything shorter. */
const DEVICE_ID_HEX_LENGTH = 64;
const PEER_ID = "a".repeat(DEVICE_ID_HEX_LENGTH);
const OTHER_ID = "b".repeat(DEVICE_ID_HEX_LENGTH);
const THIRD_ID = "c".repeat(DEVICE_ID_HEX_LENGTH);
const NOW_MS = 1_700_000_000_000;

/** A fresh, distinct, real device-id-shaped hex id, matching delivery-engine-delivery.test.ts's own precedent for the same purpose. */
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
  const shutDown = false;
  const transport = fakeTransport();
  const sendRoomRequestToMember = vi.fn().mockResolvedValue(undefined);
  const revocationRecord = vi.fn().mockResolvedValue(undefined);
  const deps: DeliveryEngineDeps = {
    agents: new Map<string, AgentIdentity>(),
    rooms: new Map<string, Room>(),
    messages: new Map(),
    dms: new Map(),
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
    setOnDelivery(fn: typeof onDelivery) {
      onDelivery = fn;
    },
    setOnPatch(fn: typeof onPatch) {
      onPatch = fn;
    },
  };
}

beforeEach(() => {
  vi.mocked(loadRoomTokens).mockReset();
  vi.mocked(loadRoomTokens).mockReturnValue({ "room-1": FAKE_TOKEN });
});

describe("DeliveryEngine — deliverToRoom directed room.notify", () => {
  it("does nothing for an unknown room", async () => {
    const h = makeHarness();
    await expect(
      h.engine.deliverToRoom("no-such-room", {
        type: "member_left",
        room: "no-such-room",
        agent: PEER_ID,
      }),
    ).resolves.toBeUndefined();
  });

  it("sends a directed room.notify to every non-self member, never broadcasting mesh-wide", async () => {
    const h = makeHarness();
    h.deps.rooms.set("room-1", room({ members: [PEER_ID, THIRD_ID] }));
    const event: DeliveryEvent = {
      type: "member_status",
      room: "room-1",
      agent: PEER_ID,
      status: "idle",
    };

    await h.engine.deliverToRoom("room-1", event);

    expect(h.sendRoomRequestToMember).toHaveBeenCalledWith(
      THIRD_ID,
      "room-1",
      FAKE_TOKEN,
      { verb: "room.notify", event },
    );
    expect(h.sendRoomRequestToMember).not.toHaveBeenCalledWith(
      PEER_ID,
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(h.transport.broadcast).not.toHaveBeenCalled();
  });

  it("fires local delivery for this store's own agent without a directed send", async () => {
    const h = makeHarness();
    h.deps.rooms.set("room-1", room({ members: [PEER_ID] }));
    const onDelivery = vi.fn();
    h.setOnDelivery(onDelivery);
    const event: DeliveryEvent = {
      type: "member_status",
      room: "room-1",
      agent: PEER_ID,
      status: "busy",
    };

    await h.engine.deliverToRoom("room-1", event);

    // fireLocalDelivery removes the event from deliveryQueues once fired (it's no longer pending for this process) -- onDelivery having been called is the real signal local delivery happened, not the queue's own post-fire contents.
    expect(onDelivery).toHaveBeenCalledWith(PEER_ID, event);
    expect(h.sendRoomRequestToMember).not.toHaveBeenCalled();
  });

  it("silently skips a member this store holds no room:member token for", async () => {
    const h = makeHarness();
    vi.mocked(loadRoomTokens).mockReturnValue({});
    h.deps.rooms.set("room-1", room({ members: [PEER_ID, THIRD_ID] }));

    await expect(
      h.engine.deliverToRoom("room-1", {
        type: "member_status",
        room: "room-1",
        agent: PEER_ID,
        status: "idle",
      }),
    ).resolves.toBeUndefined();
    expect(h.sendRoomRequestToMember).not.toHaveBeenCalled();
  });

  it("delivers to every member except the excluded one", async () => {
    const h = makeHarness();
    h.deps.rooms.set("room-1", room({ members: [PEER_ID, THIRD_ID] }));
    await h.engine.deliverToRoom(
      "room-1",
      {
        type: "member_status",
        room: "room-1",
        agent: PEER_ID,
        status: "idle",
      },
      THIRD_ID,
    );
    expect(h.deps.deliveryQueues.get(PEER_ID)).toHaveLength(1);
    expect(h.deps.deliveryQueues.get(THIRD_ID)).toBeUndefined();
  });
});

describe("DeliveryEngine — notifyRoomsOfNameChange directed self/DM-path delivery", () => {
  it("sends a directed room.notify to a remote renamed agent over the implicit DM path, never broadcasting mesh-wide", async () => {
    const h = makeHarness();
    const dmPath = `${PEER_ID}+${OTHER_ID}`;
    vi.mocked(loadRoomTokens).mockReturnValue({ [dmPath]: FAKE_TOKEN });
    h.deps.agents.set(OTHER_ID, agent({ subscribedRooms: [] }));

    await h.engine.notifyRoomsOfNameChange(OTHER_ID, "old-name", "new-name");

    expect(h.sendRoomRequestToMember).toHaveBeenCalledWith(
      OTHER_ID,
      dmPath,
      FAKE_TOKEN,
      {
        verb: "room.notify",
        event: {
          type: "name_changed",
          agent: OTHER_ID,
          oldName: "old-name",
          newName: "new-name",
        },
      },
    );
    expect(h.transport.broadcast).not.toHaveBeenCalled();
  });

  it("fires local delivery directly when renaming this store's own agent, with no DM path involved", async () => {
    const h = makeHarness();
    const onDelivery = vi.fn();
    h.setOnDelivery(onDelivery);
    h.deps.agents.set(PEER_ID, agent({ id: PEER_ID, subscribedRooms: [] }));

    await h.engine.notifyRoomsOfNameChange(PEER_ID, "old-name", "new-name");

    expect(onDelivery).toHaveBeenCalledWith(
      PEER_ID,
      expect.objectContaining({ type: "name_changed" }),
    );
    expect(h.sendRoomRequestToMember).not.toHaveBeenCalled();
    expect(h.transport.broadcast).not.toHaveBeenCalled();
  });

  it("silently skips a remote renamed agent this store holds no DM-path token for", async () => {
    const h = makeHarness();
    vi.mocked(loadRoomTokens).mockReturnValue({});
    h.deps.agents.set(OTHER_ID, agent({ subscribedRooms: [] }));

    await expect(
      h.engine.notifyRoomsOfNameChange(OTHER_ID, "old-name", "new-name"),
    ).resolves.toBeUndefined();
    expect(h.sendRoomRequestToMember).not.toHaveBeenCalled();
  });
});

describe("DeliveryEngine — emitDeliveryStatus directed remote-sender delivery", () => {
  it("sends a directed room.notify to a remote room message's sender over the room's own path", async () => {
    const h = makeHarness();
    const target = roomMessage({ id: messageId(), from: THIRD_ID });
    h.deps.messages.set("room-1", [target]);
    vi.mocked(loadRoomTokens).mockReturnValue({ "room-1": FAKE_TOKEN });

    await h.engine.deliver(OTHER_ID, {
      type: "room_message",
      message: target,
    });

    expect(h.sendRoomRequestToMember).toHaveBeenCalledWith(
      THIRD_ID,
      "room-1",
      FAKE_TOKEN,
      {
        verb: "room.notify",
        event: {
          type: "delivery_status",
          messageId: target.id,
          agent: OTHER_ID,
          status: "delivered",
          room: "room-1",
        },
      },
    );
    // deliver()'s own outer broadcastPatch (for the room_message delivery to OTHER_ID) is untouched by this change and still fires -- only the delivery_status sub-event this test targets must never itself ride a broadcast.
    expect(h.transport.broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({
        patch: expect.objectContaining({
          event: expect.objectContaining({ type: "delivery_status" }),
        }),
      }),
    );
  });

  it("sends a directed room.notify to a remote dm's sender over the dm's own path", async () => {
    const h = makeHarness();
    const dmPath = "self:x";
    const target = dmMessage({ id: messageId(), from: THIRD_ID });
    h.deps.dms.set(dmPath, [target]);
    vi.mocked(loadRoomTokens).mockReturnValue({ [dmPath]: FAKE_TOKEN });

    await h.engine.deliver(OTHER_ID, { type: "dm", message: target });

    expect(h.sendRoomRequestToMember).toHaveBeenCalledWith(
      THIRD_ID,
      dmPath,
      FAKE_TOKEN,
      {
        verb: "room.notify",
        event: {
          type: "delivery_status",
          messageId: target.id,
          agent: OTHER_ID,
          status: "delivered",
          room: undefined,
        },
      },
    );
    expect(h.transport.broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({
        patch: expect.objectContaining({
          event: expect.objectContaining({ type: "delivery_status" }),
        }),
      }),
    );
  });

  it("silently skips a remote sender this store holds no room-path token for", async () => {
    const h = makeHarness();
    const target = roomMessage({ id: messageId(), from: THIRD_ID });
    h.deps.messages.set("room-1", [target]);
    vi.mocked(loadRoomTokens).mockReturnValue({});

    await expect(
      h.engine.deliver(OTHER_ID, { type: "room_message", message: target }),
    ).resolves.toBeUndefined();
    expect(h.sendRoomRequestToMember).not.toHaveBeenCalled();
  });
});

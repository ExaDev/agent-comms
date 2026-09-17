/**
 * Direct, DI-based unit tests for RoomProtocol -- the receiving/responding half of the room wire protocol, previously exercised only through real two-peer TCP/TLS integration tests (room-send-directed, room-read-directed, dm-admission, room-join-admission, etc.), which cover the happy path end-to-end but not most individual error codes, optional-field spreads, and edge branches. RoomProtocolDeps is a narrow, injectable surface built exactly for direct testing, but token verification here is genuinely cryptographic (verifyRoomToken), so tests use real identities (generateIdentity/toIdentityPort) and real minted tokens (mintCapabilityToken) rather than opaque placeholders -- unlike room-messaging.ts's sending side, which never inspects a token's own structure.
 *
 * Split across two files to stay under this repo's max-lines cap: this file covers sendRoomRequestToMember/flushPendingRoomRequests, handleRoomJoin/admitRoomJoin, acceptRoomJoin/rejectRoomJoin, handleRoomInvite, and handleRoomLeave. See room-protocol.test.ts for handleRoomSend, handleRoomRead, handleRoomMembers, and sendRoomMessageDirected.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { bytesToHex, deviceIdFromHex } from "wire-mesh-core/domain/device-id";
import { mintCapabilityToken } from "wire-mesh-core/domain/tokens";
import { createSystemClock } from "wire-mesh-core/adapters/system-clock";
import { createRevocationView } from "wire-mesh-core/domain/revocation-view";
import type { CapabilityToken } from "wire-mesh-core/generated/protocol";
import type {
  IncomingManageRequest,
  ManageOutcome,
} from "wire-mesh-core/domain/mesh-session";
import { generateIdentity } from "../core/identity.js";
import {
  loadOrCreateIdentity,
  loadRoomTokens,
  saveRoomToken,
} from "../core/identity-store.js";
import { toIdentityPort } from "../core/wire-mesh-identity.js";
import { dmRoomPath, ownerNamedRoomPath } from "../core/room-path.js";
import { RoomProtocol, type RoomProtocolDeps } from "../core/room-protocol.js";
import { randomId } from "../core/random-id.js";
import type { AgentIdentity, Room } from "../core/types.js";

const TOKEN_TTL_MS = 60_000;
const MAX_QUEUED_DELIVERIES_PER_AGENT = 100;
/** A device-id is a 64-character lowercase hex SHA-256 digest; room-path.ts's assertDeviceIdHex rejects anything shorter. */
const DEVICE_ID_HEX_LENGTH = 64;
/** Distinct, real random ids for fixture message/ref/token ids -- randomId() is the exact utility production code (admitRoomJoin, sendRoomMessageDirected) uses for the identical purpose, so these fixtures need no arbitrary literal bytes of their own. */
const SAMPLE_MESSAGE_ID = randomId();
/** A message-id this store will never recognise, standing in for "already expired from history". */
const UNRECOGNISED_MESSAGE_ID = randomId();
/** Arbitrary, distinctive placeholder bytes for a message-ref's own id. */
const SAMPLE_REF_ID = randomId();
const SAMPLE_TOKEN_ID = randomId();

function room(overrides: Partial<Room> = {}): Room {
  return {
    id: "room-1",
    version: 1,
    name: "room-name",
    type: "public",
    owner: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    description: "a room",
    members: [],
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
    id: "",
    version: 1,
    name: "agent-name",
    harness: "pi",
    cwd: "/tmp/agent",
    pid: 1,
    startedAt: "2026-01-01T00:00:00.000Z",
    visibility: "visible",
    status: "active",
    tags: [],
    subscribedRooms: [],
    ...overrides,
  };
}

interface Identities {
  ownerId: string;
  ownerPort: Awaited<ReturnType<typeof toIdentityPort>>;
  memberId: string;
}

async function makeIdentities(): Promise<Identities> {
  const owner = generateIdentity();
  const member = generateIdentity();
  return {
    ownerId: bytesToHex(Uint8Array.from(owner.deviceId)),
    ownerPort: await toIdentityPort(owner),
    memberId: bytesToHex(Uint8Array.from(member.deviceId)),
  };
}

async function mintRoomToken(
  issuerPort: Awaited<ReturnType<typeof toIdentityPort>>,
  bearerHex: string,
  roomPath: string,
): Promise<CapabilityToken> {
  const clock = createSystemClock();
  const verdict = await mintCapabilityToken({
    identity: issuerPort,
    clock,
    tokenId: SAMPLE_TOKEN_ID,
    bearer: deviceIdFromHex(bearerHex),
    capability: "room:member",
    scope: { kind: "room", path: roomPath },
    expires: clock.now() + TOKEN_TTL_MS,
    delegationsRemaining: 0,
  });
  if (!verdict.ok)
    throw new Error("expected the fixture token to mint successfully");
  return verdict.token;
}

interface Harness {
  deps: RoomProtocolDeps;
  protocol: RoomProtocol;
  ids: Identities;
  slotDir: string;
  queueDelivery: ReturnType<typeof vi.fn>;
  fireLocalDelivery: ReturnType<typeof vi.fn>;
  bump: ReturnType<typeof vi.fn>;
  recordMemberOp: ReturnType<typeof vi.fn>;
  refreshMembership: ReturnType<typeof vi.fn>;
  broadcastPatch: ReturnType<typeof vi.fn>;
  deliverToRoom: ReturnType<typeof vi.fn>;
  revokeMemberGrant: ReturnType<typeof vi.fn>;
  sendRoomRequest: ReturnType<typeof vi.fn>;
}

async function makeHarness(): Promise<Harness> {
  const ids = await makeIdentities();
  const slotDir = fs.mkdtempSync(path.join(tmpdir(), "room-protocol-test-"));
  const slot = { harness: "test", cwd: "room-protocol", dir: slotDir };
  // saveRoomToken/saveIssuedRoomGrant write into this slot's own persisted identity file, which must already exist on disk -- unrelated to which crypto identity requireIdentity() uses for minting/verifying, purely a filesystem bookkeeping precondition.
  loadOrCreateIdentity(slot);
  const queueDelivery =
    vi.fn<RoomProtocolDeps["deliveryEngine"]["queueDelivery"]>();
  const fireLocalDelivery =
    vi.fn<RoomProtocolDeps["deliveryEngine"]["fireLocalDelivery"]>();
  const bump = vi.fn();
  const recordMemberOp =
    vi.fn<RoomProtocolDeps["deliveryEngine"]["recordMemberOp"]>();
  const refreshMembership =
    vi.fn<RoomProtocolDeps["deliveryEngine"]["refreshMembership"]>();
  const broadcastPatch = vi.fn().mockResolvedValue(undefined);
  const deliverToRoom = vi.fn().mockResolvedValue(undefined);
  const revokeMemberGrant = vi.fn().mockResolvedValue(undefined);
  const sendRoomRequest = vi
    .fn()
    .mockResolvedValue({ result: "ok" } satisfies ManageOutcome);

  const deps: RoomProtocolDeps = {
    rooms: new Map(),
    messages: new Map(),
    dms: new Map(),
    agents: new Map(),
    dmRequestsInitiatedByMe: new Set(),
    getPeerId: () => ids.ownerId,
    requireIdentity: () => ({
      identity: ids.ownerPort,
      clock: createSystemClock(),
      slot,
      revocation: createRevocationView(),
      dataStorage: {} as never,
      userIdentity: {} as never,
      userIdentityOptions: {},
    }),
    requireTransport: () =>
      ({ sendRoomRequest }) as unknown as ReturnType<
        RoomProtocolDeps["requireTransport"]
      >,
    deliveryEngine: {
      queueDelivery,
      fireLocalDelivery,
      bump,
      recordMemberOp,
      refreshMembership,
      broadcastPatch,
      deliverToRoom,
    },
    revokeMemberGrant,
  };

  return {
    deps,
    protocol: new RoomProtocol(deps),
    ids,
    slotDir,
    queueDelivery,
    fireLocalDelivery,
    bump,
    recordMemberOp,
    refreshMembership,
    broadcastPatch,
    deliverToRoom,
    revokeMemberGrant,
    sendRoomRequest,
  };
}

function handle(deviceHex: string): { id: string } {
  return { id: deviceHex };
}

function manageRequest(
  overrides: {
    scope?: { kind: string; path?: string };
    token?: CapabilityToken | undefined;
    params?: Record<string, unknown>;
  } = {},
): IncomingManageRequest {
  return {
    requestId: 1,
    command: { verb: "room:member", params: overrides.params ?? {} },
    scope: overrides.scope ?? { kind: "room", path: "room-1" },
    token: overrides.token,
    respond: vi.fn().mockResolvedValue(undefined),
  } as unknown as IncomingManageRequest;
}

describe("RoomProtocol — sendRoomRequestToMember / flushPendingRoomRequests", () => {
  /** flushPendingRoomRequests drops (rather than retries) any queued entry whose room this store holds no persisted token for -- so every test that expects a real retry needs one. The token's own cryptographic validity for the specific path doesn't matter here: flushPendingRoomRequests only checks presence via loadRoomTokens, never re-verifies it (that happens receiver-side). */
  async function persistToken(h: Harness, roomPath: string): Promise<void> {
    const token = await mintRoomToken(h.ids.ownerPort, h.ids.ownerId, roomPath);
    saveRoomToken(
      { harness: "test", cwd: "room-protocol", dir: h.slotDir },
      roomPath,
      token,
    );
  }

  it("queues for retry when the transport throws outright", async () => {
    const h = await makeHarness();
    await persistToken(h, "room-1");
    h.sendRoomRequest.mockRejectedValue(new Error("connection dropped"));

    await h.protocol.sendRoomRequestToMember(
      h.ids.memberId,
      "room-1",
      "fake-token" as unknown as CapabilityToken,
      { verb: "room.send" },
    );

    // Observable only via flushPendingRoomRequests actually retrying it once reachable.
    h.sendRoomRequest.mockResolvedValue({ result: "ok" });
    await h.protocol.flushPendingRoomRequests(h.ids.memberId);
    expect(h.sendRoomRequest).toHaveBeenCalledTimes(2);
  });

  it("queues for retry when the transport resolves with a non-ok outcome", async () => {
    const h = await makeHarness();
    await persistToken(h, "room-1");
    h.sendRoomRequest.mockResolvedValueOnce({
      result: "error",
      code: "not_connected",
    });

    await h.protocol.sendRoomRequestToMember(
      h.ids.memberId,
      "room-1",
      "fake-token" as unknown as CapabilityToken,
      { verb: "room.send" },
    );

    h.sendRoomRequest.mockResolvedValue({ result: "ok" });
    await h.protocol.flushPendingRoomRequests(h.ids.memberId);
    expect(h.sendRoomRequest).toHaveBeenCalledTimes(2);
  });

  it("does not queue anything when the transport succeeds", async () => {
    const h = await makeHarness();
    await persistToken(h, "room-1");
    h.sendRoomRequest.mockResolvedValue({ result: "ok" });

    await h.protocol.sendRoomRequestToMember(
      h.ids.memberId,
      "room-1",
      "fake-token" as unknown as CapabilityToken,
      { verb: "room.send" },
    );

    await h.protocol.flushPendingRoomRequests(h.ids.memberId);
    expect(h.sendRoomRequest).toHaveBeenCalledTimes(1);
  });

  it("bounds the retry queue oldest-first at exactly MAX_QUEUED_DELIVERIES_PER_AGENT", async () => {
    const h = await makeHarness();
    for (let i = 0; i < MAX_QUEUED_DELIVERIES_PER_AGENT + 1; i++) {
      await persistToken(h, `room-${String(i)}`);
    }
    h.sendRoomRequest.mockResolvedValue({
      result: "error",
      code: "not_connected",
    });

    for (let i = 0; i < MAX_QUEUED_DELIVERIES_PER_AGENT + 1; i++) {
      await h.protocol.sendRoomRequestToMember(
        h.ids.memberId,
        `room-${String(i)}`,
        "fake-token" as unknown as CapabilityToken,
        { verb: "room.send" },
      );
    }

    h.sendRoomRequest.mockClear();
    h.sendRoomRequest.mockResolvedValue({ result: "ok" });
    await h.protocol.flushPendingRoomRequests(h.ids.memberId);

    // The oldest entry (room-0) must have been dropped; exactly the cap's worth of retries fire.
    expect(h.sendRoomRequest).toHaveBeenCalledTimes(
      MAX_QUEUED_DELIVERIES_PER_AGENT,
    );
    const paths = h.sendRoomRequest.mock.calls.map(
      (c) => (c[2] as { path: string }).path,
    );
    expect(paths).not.toContain("room-0");
    expect(paths).toContain("room-1");
  });

  it("flushPendingRoomRequests is a no-op for a member with nothing queued", async () => {
    const h = await makeHarness();
    await expect(
      h.protocol.flushPendingRoomRequests(h.ids.memberId),
    ).resolves.toBeUndefined();
    expect(h.sendRoomRequest).not.toHaveBeenCalled();
  });

  it("drops (not re-queues) a flush entry whose room this store no longer holds a token for", async () => {
    const h = await makeHarness();
    h.sendRoomRequest.mockResolvedValueOnce({
      result: "error",
      code: "not_connected",
    });
    await h.protocol.sendRoomRequestToMember(
      h.ids.memberId,
      "no-token-room",
      "fake-token" as unknown as CapabilityToken,
      { verb: "room.send" },
    );

    h.sendRoomRequest.mockClear();
    await h.protocol.flushPendingRoomRequests(h.ids.memberId);
    expect(h.sendRoomRequest).not.toHaveBeenCalled();
  });
});

describe("RoomProtocol — handleRoomJoin / admitRoomJoin", () => {
  it("returns not_owner when an owner-named room's path names a different owner", async () => {
    const h = await makeHarness();
    const otherOwnerRoom = ownerNamedRoomPath(h.ids.memberId, "general");
    const handlerFn = h.protocol.roomVerbHandlers["room.join"];
    if (handlerFn === undefined) throw new Error("expected room.join handler");
    const outcome = await handlerFn(
      manageRequest({ scope: { kind: "room", path: otherOwnerRoom } }),
      handle(h.ids.memberId),
    );
    expect(outcome).toEqual({ result: "error", code: "not_owner" });
  });

  it("returns not_participant when a dm path doesn't include this store's own peer id", async () => {
    const h = await makeHarness();
    const strangerA = "a".repeat(DEVICE_ID_HEX_LENGTH);
    const strangerB = "b".repeat(DEVICE_ID_HEX_LENGTH);
    const foreignDm = dmRoomPath(strangerA, strangerB);
    const handlerFn = h.protocol.roomVerbHandlers["room.join"];
    if (handlerFn === undefined) throw new Error("expected room.join handler");
    const outcome = await handlerFn(
      manageRequest({ scope: { kind: "room", path: foreignDm } }),
      handle(strangerA),
    );
    expect(outcome).toEqual({ result: "error", code: "not_participant" });
  });

  it("auto-approves a dm join reply when this store already initiated the same dm path itself", async () => {
    const h = await makeHarness();
    const dmPath = dmRoomPath(h.ids.ownerId, h.ids.memberId);
    h.deps.dmRequestsInitiatedByMe.add(dmPath);
    const handlerFn = h.protocol.roomVerbHandlers["room.join"];
    if (handlerFn === undefined) throw new Error("expected room.join handler");

    const outcome = await handlerFn(
      manageRequest({ scope: { kind: "room", path: dmPath } }),
      handle(h.ids.memberId),
    );

    expect(outcome).toMatchObject({ result: "ok" });
  });

  it("holds an owner-named join open until acceptRoomJoin resolves it, then mints and returns a granted token", async () => {
    const h = await makeHarness();
    const roomPath = ownerNamedRoomPath(h.ids.ownerId, "general");
    h.deps.rooms.set(
      roomPath,
      room({ id: roomPath, owner: h.ids.ownerId, members: [h.ids.ownerId] }),
    );
    const handlerFn = h.protocol.roomVerbHandlers["room.join"];
    if (handlerFn === undefined) throw new Error("expected room.join handler");

    const pending = handlerFn(
      manageRequest({ scope: { kind: "room", path: roomPath } }),
      handle(h.ids.memberId),
    );
    await Promise.resolve();
    expect(h.protocol.listPendingRoomJoins()).toEqual([
      { roomPath, requesterId: h.ids.memberId },
    ]);

    h.protocol.acceptRoomJoin(roomPath, h.ids.memberId);
    const outcome = await pending;

    expect(outcome).toMatchObject({ result: "ok" });
    if (outcome.result !== "ok") return;
    expect(outcome).toHaveProperty("granted-token");
    expect(h.protocol.listPendingRoomJoins()).toEqual([]);
    expect(h.bump).toHaveBeenCalledWith(
      expect.objectContaining({ id: roomPath }),
    );
    expect(h.recordMemberOp).toHaveBeenCalledWith(
      expect.anything(),
      "member",
      "join",
      h.ids.memberId,
    );
  });

  it("returns a denied error, with the reason when given, once rejectRoomJoin resolves it", async () => {
    const h = await makeHarness();
    const roomPath = ownerNamedRoomPath(h.ids.ownerId, "general");
    h.deps.rooms.set(roomPath, room({ id: roomPath, owner: h.ids.ownerId }));
    const handlerFn = h.protocol.roomVerbHandlers["room.join"];
    if (handlerFn === undefined) throw new Error("expected room.join handler");

    const pending = handlerFn(
      manageRequest({ scope: { kind: "room", path: roomPath } }),
      handle(h.ids.memberId),
    );
    await Promise.resolve();
    h.protocol.rejectRoomJoin(roomPath, h.ids.memberId, "not right now");
    const outcome = await pending;

    expect(outcome).toEqual({
      result: "error",
      code: "denied",
      message: "not right now",
    });
  });

  it("mints a fresh, independent root grant when no local Room record exists (a dm join)", async () => {
    const h = await makeHarness();
    const dmPath = dmRoomPath(h.ids.ownerId, h.ids.memberId);
    h.deps.dmRequestsInitiatedByMe.add(dmPath);
    const handlerFn = h.protocol.roomVerbHandlers["room.join"];
    if (handlerFn === undefined) throw new Error("expected room.join handler");

    const outcome = await handlerFn(
      manageRequest({ scope: { kind: "room", path: dmPath } }),
      handle(h.ids.memberId),
    );

    expect(outcome).toMatchObject({
      result: "ok",
      members: [
        { device: deviceIdFromHex(h.ids.ownerId) },
        { device: deviceIdFromHex(h.ids.memberId) },
      ],
    });
    expect(h.bump).not.toHaveBeenCalled();
  });
});

describe("RoomProtocol — acceptRoomJoin / rejectRoomJoin without a pending request", () => {
  it("acceptRoomJoin throws NOT_PENDING naming the requester and room", async () => {
    const h = await makeHarness();
    expect(() => h.protocol.acceptRoomJoin("room-1", "nobody")).toThrow(
      expect.objectContaining({
        message: "No pending room.join for nobody on room-1",
        code: "NOT_PENDING",
      }),
    );
  });

  it("rejectRoomJoin throws NOT_PENDING naming the requester and room", async () => {
    const h = await makeHarness();
    expect(() => h.protocol.rejectRoomJoin("room-1", "nobody")).toThrow(
      expect.objectContaining({
        message: "No pending room.join for nobody on room-1",
        code: "NOT_PENDING",
      }),
    );
  });
});

describe("RoomProtocol — handleRoomInvite", () => {
  it("returns missing_scope_path when the request carries no room path", async () => {
    const h = await makeHarness();
    const handlerFn = h.protocol.roomVerbHandlers["room.invite"];
    if (handlerFn === undefined)
      throw new Error("expected room.invite handler");
    const outcome = await handlerFn(
      manageRequest({ scope: { kind: "room" } }),
      handle(h.ids.memberId),
    );
    expect(outcome).toEqual({ result: "error", code: "missing_scope_path" });
  });

  it("returns malformed_params for params that don't satisfy the room.invite schema", async () => {
    const h = await makeHarness();
    const roomPath = ownerNamedRoomPath(h.ids.memberId, "general");
    const handlerFn = h.protocol.roomVerbHandlers["room.invite"];
    if (handlerFn === undefined)
      throw new Error("expected room.invite handler");
    const outcome = await handlerFn(
      manageRequest({
        scope: { kind: "room", path: roomPath },
        params: { verb: "room.invite" },
      }),
      handle(h.ids.memberId),
    );
    expect(outcome).toEqual({ result: "error", code: "malformed_params" });
  });

  it("returns unauthorized for an embedded token that fails verification", async () => {
    const h = await makeHarness();
    const roomPath = ownerNamedRoomPath(h.ids.memberId, "general");
    const wrongBearerToken = await mintRoomToken(
      h.ids.ownerPort,
      h.ids.ownerId,
      roomPath,
    );
    const handlerFn = h.protocol.roomVerbHandlers["room.invite"];
    if (handlerFn === undefined)
      throw new Error("expected room.invite handler");
    const outcome = await handlerFn(
      manageRequest({
        scope: { kind: "room", path: roomPath },
        params: {
          verb: "room.invite",
          invitee: deviceIdFromHex(h.ids.ownerId),
          token: wrongBearerToken,
        },
      }),
      handle(h.ids.memberId),
    );
    expect(outcome).toEqual({ result: "error", code: "unauthorized" });
  });

  it("persists a verified invite token and fires a room_invite event, with real inviter/room-state when given, falling back to bare device-id/room-path otherwise", async () => {
    const h = await makeHarness();
    // The invite's own token must be bearer=this store's own peer id, root=the room's real owner.
    const owningMemberIdentity = generateIdentity();
    const owningMemberHex = bytesToHex(
      Uint8Array.from(owningMemberIdentity.deviceId),
    );
    const owningMemberPort = await toIdentityPort(owningMemberIdentity);
    const ownedRoomPath = ownerNamedRoomPath(owningMemberHex, "general");
    const inviteToken = await mintRoomToken(
      owningMemberPort,
      h.ids.ownerId,
      ownedRoomPath,
    );

    const handlerFn = h.protocol.roomVerbHandlers["room.invite"];
    if (handlerFn === undefined)
      throw new Error("expected room.invite handler");
    const outcome = await handlerFn(
      manageRequest({
        scope: { kind: "room", path: ownedRoomPath },
        params: {
          verb: "room.invite",
          invitee: deviceIdFromHex(h.ids.ownerId),
          token: inviteToken,
          "room-state": {
            name: "General",
            description: "a real room",
            type: "public",
          },
          "inviter-agent": { name: "Owning Member", cwd: "/tmp/owner" },
        },
      }),
      handle(h.ids.memberId),
    );

    expect(outcome).toEqual({ result: "ok" });
    expect(
      loadRoomTokens({ harness: "test", cwd: "room-protocol", dir: h.slotDir })[
        ownedRoomPath
      ],
    ).toBeDefined();
    expect(h.queueDelivery).toHaveBeenCalledWith(
      h.ids.ownerId,
      expect.objectContaining({
        type: "room_invite",
        room: ownedRoomPath,
        roomDescription: "a real room",
        from: owningMemberHex,
        fromName: "Owning Member",
        fromCwd: "/tmp/owner",
      }),
    );
  });

  it("falls back to bare device-id and empty description/cwd when room-state/inviter-agent are absent", async () => {
    const h = await makeHarness();
    const owningMemberIdentity = generateIdentity();
    const owningMemberHex = bytesToHex(
      Uint8Array.from(owningMemberIdentity.deviceId),
    );
    const owningMemberPort = await toIdentityPort(owningMemberIdentity);
    const ownedRoomPath = ownerNamedRoomPath(owningMemberHex, "general");
    const inviteToken = await mintRoomToken(
      owningMemberPort,
      h.ids.ownerId,
      ownedRoomPath,
    );

    const handlerFn = h.protocol.roomVerbHandlers["room.invite"];
    if (handlerFn === undefined)
      throw new Error("expected room.invite handler");
    await handlerFn(
      manageRequest({
        scope: { kind: "room", path: ownedRoomPath },
        params: {
          verb: "room.invite",
          invitee: deviceIdFromHex(h.ids.ownerId),
          token: inviteToken,
        },
      }),
      handle(h.ids.memberId),
    );

    expect(h.queueDelivery).toHaveBeenCalledWith(
      h.ids.ownerId,
      expect.objectContaining({
        roomDescription: "",
        from: owningMemberHex,
        fromName: owningMemberHex,
        fromCwd: "",
      }),
    );
  });
});

describe("RoomProtocol — handleRoomLeave", () => {
  let h: Harness;
  let ownerNamedRoom: string;

  beforeEach(async () => {
    h = await makeHarness();
    ownerNamedRoom = ownerNamedRoomPath(h.ids.ownerId, "general");
  });

  it("returns missing_scope_path when the request carries no room path", async () => {
    const handlerFn = h.protocol.roomVerbHandlers["room.leave"];
    if (handlerFn === undefined) throw new Error("expected room.leave handler");
    const outcome = await handlerFn(
      manageRequest({ scope: { kind: "room" } }),
      handle(h.ids.memberId),
    );
    expect(outcome).toEqual({ result: "error", code: "missing_scope_path" });
  });

  it("returns unauthorized when no token is presented", async () => {
    const handlerFn = h.protocol.roomVerbHandlers["room.leave"];
    if (handlerFn === undefined) throw new Error("expected room.leave handler");
    const outcome = await handlerFn(
      manageRequest({ scope: { kind: "room", path: ownerNamedRoom } }),
      handle(h.ids.memberId),
    );
    expect(outcome).toEqual({ result: "error", code: "unauthorized" });
  });

  it("returns malformed_params for params that don't satisfy the room.leave schema", async () => {
    h.deps.rooms.set(
      ownerNamedRoom,
      room({
        id: ownerNamedRoom,
        owner: h.ids.ownerId,
        members: [h.ids.memberId],
      }),
    );
    const token = await mintRoomToken(
      h.ids.ownerPort,
      h.ids.memberId,
      ownerNamedRoom,
    );
    const handlerFn = h.protocol.roomVerbHandlers["room.leave"];
    if (handlerFn === undefined) throw new Error("expected room.leave handler");
    const outcome = await handlerFn(
      manageRequest({
        scope: { kind: "room", path: ownerNamedRoom },
        token,
        params: { verb: "wrong" },
      }),
      handle(h.ids.memberId),
    );
    expect(outcome).toEqual({ result: "error", code: "malformed_params" });
  });

  it("returns room_not_found when this store holds no Room record at all", async () => {
    const token = await mintRoomToken(
      h.ids.ownerPort,
      h.ids.memberId,
      ownerNamedRoom,
    );
    const handlerFn = h.protocol.roomVerbHandlers["room.leave"];
    if (handlerFn === undefined) throw new Error("expected room.leave handler");
    const outcome = await handlerFn(
      manageRequest({
        scope: { kind: "room", path: ownerNamedRoom },
        token,
        params: { verb: "room.leave" },
      }),
      handle(h.ids.memberId),
    );
    expect(outcome).toEqual({ result: "error", code: "room_not_found" });
  });

  it("is a no-op ok when the sender was neither a member nor invited", async () => {
    h.deps.rooms.set(
      ownerNamedRoom,
      room({
        id: ownerNamedRoom,
        owner: h.ids.ownerId,
        members: [h.ids.ownerId],
      }),
    );
    const token = await mintRoomToken(
      h.ids.ownerPort,
      h.ids.memberId,
      ownerNamedRoom,
    );
    const handlerFn = h.protocol.roomVerbHandlers["room.leave"];
    if (handlerFn === undefined) throw new Error("expected room.leave handler");
    const outcome = await handlerFn(
      manageRequest({
        scope: { kind: "room", path: ownerNamedRoom },
        token,
        params: { verb: "room.leave" },
      }),
      handle(h.ids.memberId),
    );
    expect(outcome).toEqual({ result: "ok" });
    expect(h.revokeMemberGrant).not.toHaveBeenCalled();
  });

  it("a real member leaving revokes their grant, records a member leave, and broadcasts member_left to the room", async () => {
    h.deps.rooms.set(
      ownerNamedRoom,
      room({
        id: ownerNamedRoom,
        owner: h.ids.ownerId,
        members: [h.ids.ownerId, h.ids.memberId],
      }),
    );
    const token = await mintRoomToken(
      h.ids.ownerPort,
      h.ids.memberId,
      ownerNamedRoom,
    );
    const handlerFn = h.protocol.roomVerbHandlers["room.leave"];
    if (handlerFn === undefined) throw new Error("expected room.leave handler");

    const outcome = await handlerFn(
      manageRequest({
        scope: { kind: "room", path: ownerNamedRoom },
        token,
        params: { verb: "room.leave" },
      }),
      handle(h.ids.memberId),
    );

    expect(outcome).toEqual({ result: "ok" });
    expect(h.revokeMemberGrant).toHaveBeenCalledWith(
      ownerNamedRoom,
      h.ids.memberId,
    );
    expect(h.recordMemberOp).toHaveBeenCalledWith(
      expect.anything(),
      "member",
      "leave",
      h.ids.memberId,
    );
    expect(h.broadcastPatch).toHaveBeenCalledWith({
      type: "room_upsert",
      room: expect.anything(),
    });
    expect(h.deliverToRoom).toHaveBeenCalledWith(
      ownerNamedRoom,
      { type: "member_left", room: ownerNamedRoom, agent: h.ids.memberId },
      h.ids.memberId,
    );
  });

  it("declining a never-accepted invite records an invited leave and fires a local invite_declined event instead of broadcasting", async () => {
    h.deps.rooms.set(
      ownerNamedRoom,
      room({
        id: ownerNamedRoom,
        owner: h.ids.ownerId,
        members: [h.ids.ownerId],
        invited: [h.ids.memberId],
      }),
    );
    h.deps.agents.set(
      h.ids.memberId,
      agent({ id: h.ids.memberId, name: "Declining Member" }),
    );
    const token = await mintRoomToken(
      h.ids.ownerPort,
      h.ids.memberId,
      ownerNamedRoom,
    );
    const handlerFn = h.protocol.roomVerbHandlers["room.leave"];
    if (handlerFn === undefined) throw new Error("expected room.leave handler");

    const outcome = await handlerFn(
      manageRequest({
        scope: { kind: "room", path: ownerNamedRoom },
        token,
        params: { verb: "room.leave", reason: "changed my mind" },
      }),
      handle(h.ids.memberId),
    );

    expect(outcome).toEqual({ result: "ok" });
    expect(h.recordMemberOp).toHaveBeenCalledWith(
      expect.anything(),
      "invited",
      "leave",
      h.ids.memberId,
    );
    expect(h.deliverToRoom).not.toHaveBeenCalled();
    expect(h.queueDelivery).toHaveBeenCalledWith(
      h.ids.ownerId,
      expect.objectContaining({
        type: "invite_declined",
        agentName: "Declining Member",
        reason: "changed my mind",
      }),
    );
  });

  it("falls back to the bare device-id and empty reason when the decliner isn't a known agent or gives no reason", async () => {
    h.deps.rooms.set(
      ownerNamedRoom,
      room({
        id: ownerNamedRoom,
        owner: h.ids.ownerId,
        members: [h.ids.ownerId],
        invited: [h.ids.memberId],
      }),
    );
    const token = await mintRoomToken(
      h.ids.ownerPort,
      h.ids.memberId,
      ownerNamedRoom,
    );
    const handlerFn = h.protocol.roomVerbHandlers["room.leave"];
    if (handlerFn === undefined) throw new Error("expected room.leave handler");

    await handlerFn(
      manageRequest({
        scope: { kind: "room", path: ownerNamedRoom },
        token,
        params: { verb: "room.leave" },
      }),
      handle(h.ids.memberId),
    );

    expect(h.queueDelivery).toHaveBeenCalledWith(
      h.ids.ownerId,
      expect.objectContaining({
        agentName: h.ids.memberId,
        reason: "",
      }),
    );
  });
});

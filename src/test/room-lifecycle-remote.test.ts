/**
 * Direct, DI-based unit tests for RoomLifecycle's own remote-request-sending half -- refreshRoomMembers, requestDmAccess, getRoom, revokeMemberGrant, and declineInvite, moved here from room-lifecycle.test.ts/room-lifecycle-membership.test.ts to stay under this repo's max-lines cap after later gap-closing passes. See room-lifecycle.test.ts for createRoom/listRooms/joinRoom/joinRemoteRoom, and room-lifecycle-membership.test.ts for leaveRoom/leaveRemoteRoom/inviteToRoom/kickFromRoom/destroyRoom -- and either file's own header for the full rationale. Real identities and real minted tokens throughout (not opaque placeholders): RoomLifecycle genuinely mints capability tokens and parses roomJoinOkSchema/roomMembersOkSchema's own structural shape (a real COSE_Sign1 tuple, though never signature-verified by this class), so an arbitrary placeholder string fails the schema outright where room-messaging.test.ts's forwarding-only case could get away with one.
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
import type { ManageOutcome } from "wire-mesh-core/domain/mesh-session";
import { generateIdentity } from "../core/identity.js";
import {
  loadOrCreateIdentity,
  loadIssuedRoomGrant,
  loadRoomTokens,
  saveIssuedRoomGrant,
  saveRoomToken,
} from "../core/identity-store.js";
import { toIdentityPort } from "../core/wire-mesh-identity.js";
import { dmRoomPath, ownerNamedRoomPath } from "../core/room-path.js";
import { randomId } from "../core/random-id.js";
import {
  RoomLifecycle,
  type RoomLifecycleDeps,
} from "../core/room-lifecycle.js";
import type { AgentIdentity, Room } from "../core/types.js";

const TOKEN_TTL_MS = 60_000;

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
    tokenId: randomId(),
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
  deps: RoomLifecycleDeps;
  lifecycle: RoomLifecycle;
  ids: Identities;
  slotDir: string;
  bump: RoomLifecycleDeps["deliveryEngine"]["bump"];
  recordMemberOp: ReturnType<typeof vi.fn>;
  refreshMembership: ReturnType<typeof vi.fn>;
  broadcastPatch: ReturnType<typeof vi.fn>;
  deliverToRoom: ReturnType<typeof vi.fn>;
  deliverLocallyAndBroadcast: ReturnType<typeof vi.fn>;
  broadcastRoomJoin: ReturnType<typeof vi.fn>;
  broadcastRoomLeave: ReturnType<typeof vi.fn>;
  sendRoomRequest: ReturnType<typeof vi.fn>;
  broadcastRevocation: ReturnType<typeof vi.fn>;
}

async function makeHarness(): Promise<Harness> {
  const ids = await makeIdentities();
  const slotDir = fs.mkdtempSync(path.join(tmpdir(), "room-lifecycle-test-"));
  const slot = { harness: "test", cwd: "room-lifecycle", dir: slotDir };
  // saveRoomToken/saveIssuedRoomGrant write into this slot's own persisted identity file, which must already exist on disk -- unrelated to which crypto identity requireIdentity() uses for minting/verifying, purely a filesystem bookkeeping precondition.
  loadOrCreateIdentity(slot);

  const bump = vi.fn((readonlyEntity: Readonly<{ version: number }>) => {
    const entity = readonlyEntity as { version: number };
    entity.version += 1;
    return entity;
  }) as unknown as RoomLifecycleDeps["deliveryEngine"]["bump"];
  const recordMemberOp = vi.fn<
    RoomLifecycleDeps["deliveryEngine"]["recordMemberOp"]
  >((r, list, op, agentId) => {
    const joins = list === "member" ? r.memberJoins : r.invitedJoins;
    const leaves = list === "member" ? r.memberLeaves : r.invitedLeaves;
    if (op === "join") joins[agentId] = r.version;
    else leaves[agentId] = r.version;
  });
  const refreshMembership = vi.fn<
    RoomLifecycleDeps["deliveryEngine"]["refreshMembership"]
  >((r) => {
    r.members = Object.keys(r.memberJoins).filter(
      (id) => (r.memberJoins[id] ?? 0) > (r.memberLeaves[id] ?? 0),
    );
    r.invited = Object.keys(r.invitedJoins).filter(
      (id) => (r.invitedJoins[id] ?? 0) > (r.invitedLeaves[id] ?? 0),
    );
  });
  const broadcastPatch = vi.fn().mockResolvedValue(undefined);
  const deliverToRoom = vi.fn().mockResolvedValue(undefined);
  const deliverLocallyAndBroadcast = vi.fn().mockResolvedValue(undefined);
  const broadcastRoomJoin = vi.fn().mockResolvedValue(undefined);
  const broadcastRoomLeave = vi.fn().mockResolvedValue(undefined);
  const broadcastRevocation = vi.fn().mockResolvedValue(undefined);
  const sendRoomRequest = vi.fn().mockResolvedValue({
    result: "error",
    code: "not_connected",
  } satisfies ManageOutcome);

  const deps: RoomLifecycleDeps = {
    rooms: new Map(),
    messages: new Map(),
    agents: new Map(),
    dmRequestsInitiatedByMe: new Set(),
    getPeerId: () => ids.ownerId,
    requireIdentity: () => ({
      identity: ids.ownerPort,
      clock: createSystemClock(),
      slot,
      revocation: createRevocationView(),
      dataStorage: {} as never,
    }),
    requireTransport: () =>
      ({ sendRoomRequest, broadcastRevocation }) as unknown as ReturnType<
        RoomLifecycleDeps["requireTransport"]
      >,
    deliveryEngine: {
      bump,
      recordMemberOp,
      refreshMembership,
      broadcastPatch,
      deliverToRoom,
      deliverLocallyAndBroadcast,
    },
    federation: { broadcastRoomJoin, broadcastRoomLeave },
  };

  return {
    deps,
    lifecycle: new RoomLifecycle(deps),
    ids,
    slotDir,
    bump,
    recordMemberOp,
    refreshMembership,
    broadcastPatch,
    deliverToRoom,
    deliverLocallyAndBroadcast,
    broadcastRoomJoin,
    broadcastRoomLeave,
    sendRoomRequest,
    broadcastRevocation,
  };
}

function roomJoinOkOutcome(
  token: CapabilityToken,
  members: readonly string[],
  extra: Record<string, unknown> = {},
): ManageOutcome {
  return {
    result: "ok",
    "granted-token": token,
    members: members.map((hex) => ({ device: deviceIdFromHex(hex) })),
    ...extra,
  } as unknown as ManageOutcome;
}

function roomMembersOkOutcome(
  members: readonly string[],
  extra: Record<string, unknown> = {},
): ManageOutcome {
  return {
    result: "ok",
    members: members.map((hex) => ({ device: deviceIdFromHex(hex) })),
    ...extra,
  } as unknown as ManageOutcome;
}
describe("RoomLifecycle — refreshRoomMembers", () => {
  it("throws ROOM_NOT_FOUND for a non-owner-named path", async () => {
    const h = await makeHarness();
    const dmPath = dmRoomPath(h.ids.ownerId, h.ids.memberId);
    await expect(h.lifecycle.refreshRoomMembers(dmPath)).rejects.toMatchObject({
      code: "ROOM_NOT_FOUND",
    });
  });

  it("throws NOT_MEMBER when no room:member token is persisted", async () => {
    const h = await makeHarness();
    const roomPath = ownerNamedRoomPath(h.ids.memberId, "r");
    await expect(
      h.lifecycle.refreshRoomMembers(roomPath),
    ).rejects.toMatchObject({
      message: `No room:member token for ${roomPath}`,
      code: "NOT_MEMBER",
    });
  });

  it("throws REFRESH_FAILED naming the outcome code on a non-ok outcome", async () => {
    const h = await makeHarness();
    const roomPath = ownerNamedRoomPath(h.ids.memberId, "r");
    const { slot } = h.deps.requireIdentity();
    const token = await mintRoomToken(h.ids.ownerPort, h.ids.ownerId, roomPath);
    saveRoomToken(slot, roomPath, token);
    h.sendRoomRequest.mockResolvedValue({
      result: "error",
      code: "not_a_member",
    } satisfies ManageOutcome);
    await expect(
      h.lifecycle.refreshRoomMembers(roomPath),
    ).rejects.toMatchObject({
      message: `room.members refresh for ${roomPath} failed (not_a_member)`,
      code: "REFRESH_FAILED",
    });
  });

  it("throws MALFORMED_RESPONSE when the outcome fails the roomMembersOk schema", async () => {
    const h = await makeHarness();
    const roomPath = ownerNamedRoomPath(h.ids.memberId, "r");
    const { slot } = h.deps.requireIdentity();
    const token = await mintRoomToken(h.ids.ownerPort, h.ids.ownerId, roomPath);
    saveRoomToken(slot, roomPath, token);
    h.sendRoomRequest.mockResolvedValue({
      result: "ok",
      nonsense: true,
    });
    await expect(
      h.lifecycle.refreshRoomMembers(roomPath),
    ).rejects.toMatchObject({
      message: `room.members response for ${roomPath} was malformed`,
      code: "MALFORMED_RESPONSE",
    });
  });

  it("sends the request scoped to the room path, over a room.members verb", async () => {
    const h = await makeHarness();
    const roomPath = ownerNamedRoomPath(h.ids.memberId, "r");
    const { slot } = h.deps.requireIdentity();
    const token = await mintRoomToken(h.ids.ownerPort, h.ids.ownerId, roomPath);
    saveRoomToken(slot, roomPath, token);
    h.sendRoomRequest.mockResolvedValue(roomMembersOkOutcome([h.ids.ownerId]));
    await h.lifecycle.refreshRoomMembers(roomPath);
    expect(h.sendRoomRequest).toHaveBeenCalledWith(
      h.ids.memberId,
      expect.objectContaining({
        params: expect.objectContaining({ verb: "room.members" }),
      }),
      { kind: "room", path: roomPath },
      token,
    );
  });

  it("starts the version at 1, with an empty description and no existing local copy", async () => {
    const h = await makeHarness();
    const roomPath = ownerNamedRoomPath(h.ids.memberId, "r");
    const { slot } = h.deps.requireIdentity();
    const token = await mintRoomToken(h.ids.ownerPort, h.ids.ownerId, roomPath);
    saveRoomToken(slot, roomPath, token);
    h.sendRoomRequest.mockResolvedValue(roomMembersOkOutcome([h.ids.ownerId]));
    const refreshed = await h.lifecycle.refreshRoomMembers(roomPath);
    expect(refreshed.version).toBe(1);
    expect(refreshed.description).toBe("");
    expect(refreshed.federated).toBe(false);
    expect(refreshed.memberJoins).toEqual({ [h.ids.ownerId]: 1 });
    expect(refreshed.invited).toEqual([]);
  });

  it("increments the version relative to the existing local copy, and preserves its federated flag", async () => {
    const h = await makeHarness();
    const roomPath = ownerNamedRoomPath(h.ids.memberId, "r");
    h.deps.rooms.set(
      roomPath,
      room({ id: roomPath, version: 1, federated: true }),
    );
    const { slot } = h.deps.requireIdentity();
    const token = await mintRoomToken(h.ids.ownerPort, h.ids.ownerId, roomPath);
    saveRoomToken(slot, roomPath, token);
    h.sendRoomRequest.mockResolvedValue(roomMembersOkOutcome([h.ids.ownerId]));
    const refreshed = await h.lifecycle.refreshRoomMembers(roomPath);
    expect(refreshed.version).toBe(2);
    expect(refreshed.federated).toBe(true);
  });

  it("prefers the room-state extension's own fields over the existing local copy's", async () => {
    const h = await makeHarness();
    const roomPath = ownerNamedRoomPath(h.ids.memberId, "r");
    h.deps.rooms.set(
      roomPath,
      room({ id: roomPath, name: "old-name", description: "old-desc" }),
    );
    const { slot } = h.deps.requireIdentity();
    const token = await mintRoomToken(h.ids.ownerPort, h.ids.ownerId, roomPath);
    saveRoomToken(slot, roomPath, token);
    h.sendRoomRequest.mockResolvedValue(
      roomMembersOkOutcome([h.ids.ownerId], {
        "room-state": {
          name: "new-name",
          description: "new-desc",
          type: "private",
        },
      }),
    );
    const refreshed = await h.lifecycle.refreshRoomMembers(roomPath);
    expect(refreshed.name).toBe("new-name");
    expect(refreshed.description).toBe("new-desc");
  });
});

describe("RoomLifecycle — requestDmAccess", () => {
  it("records the dm path as initiated by this store before sending", async () => {
    const h = await makeHarness();
    h.sendRoomRequest.mockResolvedValue({
      result: "error",
      code: "not_invited",
    } satisfies ManageOutcome);
    await expect(
      h.lifecycle.requestDmAccess(h.ids.memberId),
    ).rejects.toBeDefined();
    expect(h.deps.dmRequestsInitiatedByMe).toContain(
      dmRoomPath(h.ids.ownerId, h.ids.memberId),
    );
  });

  it("throws JOIN_REFUSED naming the outcome code on a non-ok outcome", async () => {
    const h = await makeHarness();
    h.sendRoomRequest.mockResolvedValue({
      result: "error",
      code: "not_invited",
    } satisfies ManageOutcome);
    await expect(
      h.lifecycle.requestDmAccess(h.ids.memberId),
    ).rejects.toMatchObject({
      message: `DM access request to ${h.ids.memberId} was refused (not_invited)`,
      code: "JOIN_REFUSED",
    });
  });

  it("throws MALFORMED_RESPONSE when the outcome fails the roomJoinOk schema", async () => {
    const h = await makeHarness();
    h.sendRoomRequest.mockResolvedValue({
      result: "ok",
      nonsense: true,
    });
    await expect(
      h.lifecycle.requestDmAccess(h.ids.memberId),
    ).rejects.toMatchObject({
      message: `DM access response from ${h.ids.memberId} was malformed`,
      code: "MALFORMED_RESPONSE",
    });
  });

  it("persists the granted token under the dm path on success", async () => {
    const h = await makeHarness();
    const dmPath = dmRoomPath(h.ids.ownerId, h.ids.memberId);
    const token = await mintRoomToken(h.ids.ownerPort, h.ids.ownerId, dmPath);
    h.sendRoomRequest.mockResolvedValue(roomJoinOkOutcome(token, []));
    await h.lifecycle.requestDmAccess(h.ids.memberId);
    const { slot } = h.deps.requireIdentity();
    expect(loadRoomTokens(slot)[dmPath]).toBeDefined();
  });
});

describe("RoomLifecycle — getRoom", () => {
  it("returns the stored room", async () => {
    const h = await makeHarness();
    const r = room({ id: "room-1" });
    h.deps.rooms.set("room-1", r);
    await expect(h.lifecycle.getRoom("room-1")).resolves.toBe(r);
  });

  it("returns undefined for an unknown id", async () => {
    const h = await makeHarness();
    await expect(h.lifecycle.getRoom("no-such-room")).resolves.toBeUndefined();
  });
});

/** Persists an issued-grant record for memberId in roomPath as if this store's own identity had genuinely admitted them (invite or join), via the same real crypto path inviteToRoom itself uses -- revokeMemberGrant/kickFromRoom/destroyRoom all read this record by its own token-id, not anything derivable from the token or the in-memory Room object afterward. */
async function seedIssuedGrant(
  h: Harness,
  roomPath: string,
  memberId: string,
): Promise<void> {
  const { slot } = h.deps.requireIdentity();
  const tokenId = randomId();
  const clock = createSystemClock();
  const verdict = await mintCapabilityToken({
    identity: h.ids.ownerPort,
    clock,
    tokenId,
    bearer: deviceIdFromHex(memberId),
    capability: "room:member",
    scope: { kind: "room", path: roomPath },
    expires: clock.now() + TOKEN_TTL_MS,
    delegationsRemaining: 0,
  });
  if (!verdict.ok)
    throw new Error("expected the fixture token to mint successfully");
  saveIssuedRoomGrant(slot, roomPath, memberId, tokenId);
}

describe("RoomLifecycle — revokeMemberGrant", () => {
  it("does nothing when no issued-grant record exists for the member", async () => {
    const h = await makeHarness();
    await expect(
      h.lifecycle.revokeMemberGrant("room-1", h.ids.memberId),
    ).resolves.toBeUndefined();
    expect(h.broadcastRevocation).not.toHaveBeenCalled();
  });

  it("mints and broadcasts a revocation entry, then forgets the issued-grant record", async () => {
    const h = await makeHarness();
    await seedIssuedGrant(h, "room-1", h.ids.memberId);
    await h.lifecycle.revokeMemberGrant("room-1", h.ids.memberId);
    expect(h.broadcastRevocation).toHaveBeenCalledTimes(1);
    const { slot } = h.deps.requireIdentity();
    expect(loadIssuedRoomGrant(slot, "room-1", h.ids.memberId)).toBeUndefined();
  });
});

describe("RoomLifecycle — declineInvite", () => {
  it("throws NOT_SELF when declining on behalf of another agent", async () => {
    const h = await makeHarness();
    await expect(
      h.lifecycle.declineInvite("room-1", h.ids.memberId, "no thanks"),
    ).rejects.toMatchObject({
      message: `Cannot decline an invite on behalf of ${h.ids.memberId}`,
      code: "NOT_SELF",
    });
  });

  it("throws ROOM_NOT_FOUND for a non-owner-named path (e.g. a DM path)", async () => {
    const h = await makeHarness();
    const dmPath = dmRoomPath(h.ids.ownerId, h.ids.memberId);
    await expect(
      h.lifecycle.declineInvite(dmPath, h.ids.ownerId, "no thanks"),
    ).rejects.toMatchObject({
      message: `Room ${dmPath} not found`,
      code: "ROOM_NOT_FOUND",
    });
  });

  it("delegates to a real room.leave request against the room's own owner, carrying the decline reason", async () => {
    const h = await makeHarness();
    const roomPath = ownerNamedRoomPath(h.ids.memberId, "r");
    const { slot } = h.deps.requireIdentity();
    const token = await mintRoomToken(h.ids.ownerPort, h.ids.ownerId, roomPath);
    saveRoomToken(slot, roomPath, token);
    h.sendRoomRequest.mockResolvedValue({
      result: "ok",
    } satisfies ManageOutcome);
    await h.lifecycle.declineInvite(roomPath, h.ids.ownerId, "no thanks");
    expect(h.sendRoomRequest).toHaveBeenCalledWith(
      h.ids.memberId,
      expect.objectContaining({
        params: expect.objectContaining({
          verb: "room.leave",
          reason: "no thanks",
        }),
      }),
      { kind: "room", path: roomPath },
      token,
    );
  });
});

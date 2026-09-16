/**
 * Direct, DI-based unit tests for RoomLifecycle's membership-grant half -- leaveRoom/leaveRemoteRoom, inviteToRoom, kickFromRoom, and destroyRoom. Split from room-lifecycle.test.ts (createRoom/listRooms/joinRoom) and room-lifecycle-remote.test.ts (refreshRoomMembers/requestDmAccess/getRoom/revokeMemberGrant/declineInvite) to stay under this repo's max-lines cap. All three files share an identical preamble (helpers, fakes, makeHarness) by necessity of the split -- see room-lifecycle.test.ts's own header for the full rationale (real identities/tokens, not opaque placeholders, since this class genuinely mints and revokes capability tokens).
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
  deliverToMember: ReturnType<typeof vi.fn>;
  sendRoomRequest: ReturnType<typeof vi.fn>;
  broadcastRevocation: ReturnType<typeof vi.fn>;
}

async function makeHarness(): Promise<Harness> {
  const ids = await makeIdentities();
  const slotDir = fs.mkdtempSync(
    path.join(tmpdir(), "room-lifecycle-membership-test-"),
  );
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
  const deliverToMember = vi.fn().mockResolvedValue(undefined);
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
      deliverToMember,
    },
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
    deliverToMember,
    sendRoomRequest,
    broadcastRevocation,
  };
}

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

// Two mutants Stryker still raises here are left undocumented-but-untested, both genuinely unreachable with real crypto: inviteToRoom's own `this.deps.rooms.set(roomId, room)` call is a same-object-reference no-op (the identical pattern documented at the top of room-lifecycle.test.ts's joinRoom block), and its `if (!verdict.ok)` MINT_FAILED branch cannot fail against a validly-generated identity for the same reason mintOwnerRootGrant's own failure branch can't (documented at the top of room-lifecycle.test.ts's createRoom block).
describe("RoomLifecycle — inviteToRoom", () => {
  it("throws ROOM_NOT_FOUND for an unknown room", async () => {
    const h = await makeHarness();
    await expect(
      h.lifecycle.inviteToRoom("no-such-room", h.ids.memberId, h.ids.ownerId),
    ).rejects.toMatchObject({
      message: "Room no-such-room not found",
      code: "ROOM_NOT_FOUND",
    });
  });

  it("throws NOT_OWNER when the inviter isn't the room's own owner", async () => {
    const h = await makeHarness();
    h.deps.rooms.set("room-1", room({ id: "room-1", owner: h.ids.ownerId }));
    h.sendRoomRequest.mockResolvedValue({
      result: "ok",
    } satisfies ManageOutcome);
    await expect(
      h.lifecycle.inviteToRoom("room-1", "some-target", h.ids.memberId),
    ).rejects.toMatchObject({
      message: "Only the room owner can invite",
      code: "NOT_OWNER",
    });
  });

  it("records an invited-join only for a target not already invited or a member, and bumps the room's version", async () => {
    const h = await makeHarness();
    h.deps.rooms.set(
      "room-1",
      room({ id: "room-1", owner: h.ids.ownerId, version: 1 }),
    );
    h.sendRoomRequest.mockResolvedValue({
      result: "ok",
    } satisfies ManageOutcome);
    await h.lifecycle.inviteToRoom("room-1", h.ids.memberId, h.ids.ownerId);
    expect(h.recordMemberOp).toHaveBeenCalledWith(
      expect.anything(),
      "invited",
      "join",
      h.ids.memberId,
    );
    expect(h.deps.rooms.get("room-1")?.version).toBe(2);
  });

  it("does not re-record an invited-join for a target already invited", async () => {
    const h = await makeHarness();
    h.deps.rooms.set(
      "room-1",
      room({
        id: "room-1",
        owner: h.ids.ownerId,
        invited: [h.ids.memberId],
        invitedJoins: { [h.ids.memberId]: 1 },
      }),
    );
    h.sendRoomRequest.mockResolvedValue({
      result: "ok",
    } satisfies ManageOutcome);
    await h.lifecycle.inviteToRoom("room-1", h.ids.memberId, h.ids.ownerId);
    expect(h.recordMemberOp).not.toHaveBeenCalledWith(
      expect.anything(),
      "invited",
      "join",
      h.ids.memberId,
    );
  });

  it("does not record an invited-join for a target who is already a member", async () => {
    const h = await makeHarness();
    h.deps.rooms.set(
      "room-1",
      room({
        id: "room-1",
        owner: h.ids.ownerId,
        members: [h.ids.memberId],
        memberJoins: { [h.ids.memberId]: 1 },
      }),
    );
    h.sendRoomRequest.mockResolvedValue({
      result: "ok",
    } satisfies ManageOutcome);
    await h.lifecycle.inviteToRoom("room-1", h.ids.memberId, h.ids.ownerId);
    expect(h.recordMemberOp).not.toHaveBeenCalledWith(
      expect.anything(),
      "invited",
      "join",
      h.ids.memberId,
    );
  });

  it("persists an issued-grant record for the invited target", async () => {
    const h = await makeHarness();
    h.deps.rooms.set("room-1", room({ id: "room-1", owner: h.ids.ownerId }));
    h.sendRoomRequest.mockResolvedValue({
      result: "ok",
    } satisfies ManageOutcome);
    await h.lifecycle.inviteToRoom("room-1", h.ids.memberId, h.ids.ownerId);
    const { slot } = h.deps.requireIdentity();
    expect(loadIssuedRoomGrant(slot, "room-1", h.ids.memberId)).toBeDefined();
  });

  it("includes the inviter-agent extension only when the inviter has a local agent record", async () => {
    const withInviter = await makeHarness();
    withInviter.deps.rooms.set(
      "room-1",
      room({ id: "room-1", owner: withInviter.ids.ownerId }),
    );
    withInviter.deps.agents.set(
      withInviter.ids.ownerId,
      agent({ id: withInviter.ids.ownerId, name: "inviter-name" }),
    );
    withInviter.sendRoomRequest.mockResolvedValue({
      result: "ok",
    } satisfies ManageOutcome);
    await withInviter.lifecycle.inviteToRoom(
      "room-1",
      withInviter.ids.memberId,
      withInviter.ids.ownerId,
    );
    const params = withInviter.sendRoomRequest.mock.calls[0]?.[1]
      ?.params as Record<string, unknown>;
    expect(params).toHaveProperty("inviter-agent");

    const withoutInviter = await makeHarness();
    withoutInviter.deps.rooms.set(
      "room-1",
      room({ id: "room-1", owner: withoutInviter.ids.ownerId }),
    );
    withoutInviter.sendRoomRequest.mockResolvedValue({
      result: "ok",
    } satisfies ManageOutcome);
    await withoutInviter.lifecycle.inviteToRoom(
      "room-1",
      withoutInviter.ids.memberId,
      withoutInviter.ids.ownerId,
    );
    const params2 = withoutInviter.sendRoomRequest.mock.calls[0]?.[1]
      ?.params as Record<string, unknown>;
    expect(params2).not.toHaveProperty("inviter-agent");
  });

  it("throws INVITE_FAILED naming the outcome code on a non-ok outcome", async () => {
    const h = await makeHarness();
    h.deps.rooms.set("room-1", room({ id: "room-1", owner: h.ids.ownerId }));
    h.sendRoomRequest.mockResolvedValue({
      result: "error",
      code: "not_reachable",
    } satisfies ManageOutcome);
    await expect(
      h.lifecycle.inviteToRoom("room-1", h.ids.memberId, h.ids.ownerId),
    ).rejects.toMatchObject({
      message: `Invite to ${h.ids.memberId} for room-1 failed (not_reachable)`,
      code: "INVITE_FAILED",
    });
  });

  it("resolves without throwing on a genuinely successful invite, sent scoped to the room path", async () => {
    const h = await makeHarness();
    h.deps.rooms.set("room-1", room({ id: "room-1", owner: h.ids.ownerId }));
    h.sendRoomRequest.mockResolvedValue({
      result: "ok",
    } satisfies ManageOutcome);
    await expect(
      h.lifecycle.inviteToRoom("room-1", h.ids.memberId, h.ids.ownerId),
    ).resolves.toBeUndefined();
    expect(h.sendRoomRequest).toHaveBeenCalledWith(
      h.ids.memberId,
      expect.anything(),
      { kind: "room", path: "room-1" },
    );
  });
});

// kickFromRoom's own trailing `this.deps.rooms.set(roomId, room)` call is the same same-object-reference no-op documented at the top of room-lifecycle.test.ts's joinRoom block -- `room` is already the map's own stored reference by the time this runs.
describe("RoomLifecycle — kickFromRoom", () => {
  it("throws ROOM_NOT_FOUND for an unknown room", async () => {
    const h = await makeHarness();
    await expect(
      h.lifecycle.kickFromRoom("no-such-room", h.ids.memberId, h.ids.ownerId),
    ).rejects.toMatchObject({
      message: "Room no-such-room not found",
      code: "ROOM_NOT_FOUND",
    });
  });

  it("throws NOT_OWNER when the kicker isn't the room's own owner", async () => {
    const h = await makeHarness();
    h.deps.rooms.set(
      "room-1",
      room({
        id: "room-1",
        owner: h.ids.ownerId,
        members: [h.ids.memberId],
        memberJoins: { [h.ids.memberId]: 1 },
      }),
    );
    await expect(
      h.lifecycle.kickFromRoom("room-1", h.ids.memberId, "not-the-owner"),
    ).rejects.toMatchObject({
      message: "Only the room owner can kick",
      code: "NOT_OWNER",
    });
  });

  it("revokes the target's own issued grant", async () => {
    const h = await makeHarness();
    h.deps.rooms.set(
      "room-1",
      room({
        id: "room-1",
        owner: h.ids.ownerId,
        members: [h.ids.memberId],
        memberJoins: { [h.ids.memberId]: 1 },
      }),
    );
    await seedIssuedGrant(h, "room-1", h.ids.memberId);
    await h.lifecycle.kickFromRoom("room-1", h.ids.memberId, h.ids.ownerId);
    const { slot } = h.deps.requireIdentity();
    expect(loadIssuedRoomGrant(slot, "room-1", h.ids.memberId)).toBeUndefined();
    expect(h.broadcastRevocation).toHaveBeenCalledTimes(1);
  });

  it("removes the target from both the member and invited lists, and bumps the room's version", async () => {
    const h = await makeHarness();
    h.deps.rooms.set(
      "room-1",
      room({
        id: "room-1",
        version: 1,
        owner: h.ids.ownerId,
        members: [h.ids.memberId],
        memberJoins: { [h.ids.memberId]: 1 },
      }),
    );
    await h.lifecycle.kickFromRoom("room-1", h.ids.memberId, h.ids.ownerId);
    expect(h.recordMemberOp).toHaveBeenCalledWith(
      expect.anything(),
      "member",
      "leave",
      h.ids.memberId,
    );
    expect(h.recordMemberOp).toHaveBeenCalledWith(
      expect.anything(),
      "invited",
      "leave",
      h.ids.memberId,
    );
    const updated = h.deps.rooms.get("room-1");
    expect(updated?.version).toBe(2);
    expect(updated?.members).not.toContain(h.ids.memberId);
  });

  it("broadcasts the updated room", async () => {
    const h = await makeHarness();
    h.deps.rooms.set(
      "room-1",
      room({
        id: "room-1",
        owner: h.ids.ownerId,
        members: [h.ids.memberId],
        memberJoins: { [h.ids.memberId]: 1 },
      }),
    );
    await h.lifecycle.kickFromRoom("room-1", h.ids.memberId, h.ids.ownerId);
    expect(h.broadcastPatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "room_upsert" }),
    );
  });
});

// destroyRoom's per-member `this.deps.agents.set(memberId, member)` call is the same same-object-reference no-op documented at the top of room-lifecycle.test.ts's joinRoom block -- `member` is fetched via `this.deps.agents.get(memberId)` and mutated (its `subscribedRooms` property reassigned) in place before this call, so re-setting the map entry to the identical reference it already holds changes nothing observable.
describe("RoomLifecycle — destroyRoom", () => {
  it("throws ROOM_NOT_FOUND for an unknown room", async () => {
    const h = await makeHarness();
    await expect(
      h.lifecycle.destroyRoom("no-such-room", h.ids.ownerId),
    ).rejects.toMatchObject({
      message: "Room no-such-room not found",
      code: "ROOM_NOT_FOUND",
    });
  });

  it("throws NOT_OWNER when the requester isn't the room's own owner", async () => {
    const h = await makeHarness();
    h.deps.rooms.set("room-1", room({ id: "room-1", owner: h.ids.ownerId }));
    await expect(
      h.lifecycle.destroyRoom("room-1", h.ids.memberId),
    ).rejects.toMatchObject({
      message: "Only the room owner can destroy",
      code: "NOT_OWNER",
    });
  });

  it("revokes every member's own issued grant", async () => {
    const h = await makeHarness();
    h.deps.rooms.set(
      "room-1",
      room({
        id: "room-1",
        owner: h.ids.ownerId,
        members: [h.ids.ownerId, h.ids.memberId],
      }),
    );
    await seedIssuedGrant(h, "room-1", h.ids.memberId);
    await h.lifecycle.destroyRoom("room-1", h.ids.ownerId);
    const { slot } = h.deps.requireIdentity();
    expect(loadIssuedRoomGrant(slot, "room-1", h.ids.memberId)).toBeUndefined();
  });

  it("updates subscribedRooms and broadcasts agent_upsert only for members with a local agent record", async () => {
    const h = await makeHarness();
    h.deps.rooms.set(
      "room-1",
      room({
        id: "room-1",
        owner: h.ids.ownerId,
        members: [h.ids.ownerId, h.ids.memberId],
      }),
    );
    h.deps.agents.set(
      h.ids.memberId,
      agent({ id: h.ids.memberId, subscribedRooms: ["room-1", "other-room"] }),
    );
    await h.lifecycle.destroyRoom("room-1", h.ids.ownerId);
    expect(h.deps.agents.get(h.ids.memberId)?.subscribedRooms).toEqual([
      "other-room",
    ]);
    expect(h.broadcastPatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "agent_upsert" }),
    );
  });

  it("skips the agent_upsert broadcast for a member with no local agent record", async () => {
    const h = await makeHarness();
    h.deps.rooms.set(
      "room-1",
      room({ id: "room-1", owner: h.ids.ownerId, members: [h.ids.memberId] }),
    );
    await h.lifecycle.destroyRoom("room-1", h.ids.ownerId);
    expect(h.broadcastPatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "agent_upsert" }),
    );
  });

  it("deletes the room and its message history, and broadcasts room_delete", async () => {
    const h = await makeHarness();
    h.deps.rooms.set(
      "room-1",
      room({ id: "room-1", owner: h.ids.ownerId, members: [] }),
    );
    h.deps.messages.set("room-1", []);
    await h.lifecycle.destroyRoom("room-1", h.ids.ownerId);
    expect(h.deps.rooms.has("room-1")).toBe(false);
    expect(h.deps.messages.has("room-1")).toBe(false);
    expect(h.broadcastPatch).toHaveBeenCalledWith({
      type: "room_delete",
      roomId: "room-1",
    });
  });
});
// leaveRoom's own `this.deps.rooms.set(roomId, room)` and `this.deps.agents.set(agentId, agent)` calls are the same same-object-reference no-ops documented at the top of room-lifecycle.test.ts's joinRoom block.
describe("RoomLifecycle — leaveRoom / leaveRemoteRoom", () => {
  it("throws ROOM_NOT_FOUND for an unknown room", async () => {
    const h = await makeHarness();
    await expect(
      h.lifecycle.leaveRoom("no-such-room", h.ids.ownerId),
    ).rejects.toMatchObject({
      message: "Room no-such-room not found",
      code: "ROOM_NOT_FOUND",
    });
  });

  it("goes remote when this store's own agent leaves a room it does not own, omitting reason entirely (not just as undefined)", async () => {
    const h = await makeHarness();
    const roomPath = ownerNamedRoomPath(h.ids.memberId, "r");
    h.deps.rooms.set(roomPath, room({ id: roomPath, owner: h.ids.memberId }));
    const { slot } = h.deps.requireIdentity();
    const token = await mintRoomToken(h.ids.ownerPort, h.ids.ownerId, roomPath);
    saveRoomToken(slot, roomPath, token);
    h.sendRoomRequest.mockResolvedValue({
      result: "ok",
    } satisfies ManageOutcome);
    await h.lifecycle.leaveRoom(roomPath, h.ids.ownerId);
    expect(h.sendRoomRequest).toHaveBeenCalled();
    expect(h.deps.rooms.has(roomPath)).toBe(false);
    const params = h.sendRoomRequest.mock.calls[0]?.[1]?.params as Record<
      string,
      unknown
    >;
    expect(params).not.toHaveProperty("reason");
  });

  it("takes the local path when this store's own agent leaves a room it owns", async () => {
    const h = await makeHarness();
    h.deps.rooms.set(
      "room-1",
      room({
        id: "room-1",
        owner: h.ids.ownerId,
        members: [h.ids.ownerId, h.ids.memberId],
        memberJoins: { [h.ids.ownerId]: 1, [h.ids.memberId]: 1 },
      }),
    );
    await h.lifecycle.leaveRoom("room-1", h.ids.ownerId);
    expect(h.sendRoomRequest).not.toHaveBeenCalled();
  });

  it("always takes the local path for an agent other than this store's own peer", async () => {
    const h = await makeHarness();
    h.deps.rooms.set(
      "room-1",
      room({
        id: "room-1",
        owner: h.ids.ownerId,
        members: [h.ids.ownerId, h.ids.memberId],
        memberJoins: { [h.ids.ownerId]: 1, [h.ids.memberId]: 1 },
      }),
    );
    await h.lifecycle.leaveRoom("room-1", h.ids.memberId);
    expect(h.sendRoomRequest).not.toHaveBeenCalled();
    expect(h.deps.rooms.get("room-1")?.members).not.toContain(h.ids.memberId);
  });

  it("updates subscribedRooms and broadcasts agent_upsert only for a known agent", async () => {
    const h = await makeHarness();
    h.deps.rooms.set(
      "room-1",
      room({
        id: "room-1",
        owner: h.ids.ownerId,
        members: [h.ids.ownerId, h.ids.memberId],
        memberJoins: { [h.ids.ownerId]: 1, [h.ids.memberId]: 1 },
      }),
    );
    h.deps.agents.set(
      h.ids.memberId,
      agent({
        id: h.ids.memberId,
        subscribedRooms: ["room-1", "other-room"],
      }),
    );
    await h.lifecycle.leaveRoom("room-1", h.ids.memberId);
    expect(h.deps.agents.get(h.ids.memberId)?.subscribedRooms).toEqual([
      "other-room",
    ]);
    expect(h.broadcastPatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "agent_upsert" }),
    );
  });

  it("skips the agent_upsert broadcast when the leaving agent has no local record", async () => {
    const h = await makeHarness();
    h.deps.rooms.set(
      "room-1",
      room({
        id: "room-1",
        owner: h.ids.ownerId,
        members: [h.ids.ownerId, h.ids.memberId],
        memberJoins: { [h.ids.ownerId]: 1, [h.ids.memberId]: 1 },
      }),
    );
    await h.lifecycle.leaveRoom("room-1", h.ids.memberId);
    expect(h.broadcastPatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "agent_upsert" }),
    );
  });

  it("destroys the room when the last remaining member is also its own owner", async () => {
    const h = await makeHarness();
    h.deps.rooms.set(
      "room-1",
      room({
        id: "room-1",
        owner: h.ids.ownerId,
        members: [h.ids.ownerId],
        memberJoins: { [h.ids.ownerId]: 1 },
      }),
    );
    await h.lifecycle.leaveRoom("room-1", h.ids.ownerId);
    expect(h.deps.rooms.has("room-1")).toBe(false);
    expect(h.broadcastPatch).toHaveBeenCalledWith({
      type: "room_delete",
      roomId: "room-1",
    });
  });

  it("does not destroy the room when the last remaining member leaving is not its owner", async () => {
    const h = await makeHarness();
    h.deps.rooms.set(
      "room-1",
      room({
        id: "room-1",
        owner: h.ids.ownerId,
        members: [h.ids.memberId],
        memberJoins: { [h.ids.memberId]: 1 },
      }),
    );
    await h.lifecycle.leaveRoom("room-1", h.ids.memberId);
    expect(h.deps.rooms.has("room-1")).toBe(true);
  });

  it("leaveRemoteRoom throws NOT_MEMBER when no token is persisted for the target room", async () => {
    const h = await makeHarness();
    const roomPath = ownerNamedRoomPath(h.ids.memberId, "r");
    h.deps.rooms.set(roomPath, room({ id: roomPath, owner: h.ids.memberId }));
    await expect(
      h.lifecycle.leaveRoom(roomPath, h.ids.ownerId),
    ).rejects.toMatchObject({
      message: `No room:member token for ${roomPath}`,
      code: "NOT_MEMBER",
    });
  });

  it("leaveRemoteRoom throws LEAVE_FAILED naming the outcome code on a non-ok outcome", async () => {
    const h = await makeHarness();
    const roomPath = ownerNamedRoomPath(h.ids.memberId, "r");
    h.deps.rooms.set(roomPath, room({ id: roomPath, owner: h.ids.memberId }));
    const { slot } = h.deps.requireIdentity();
    const token = await mintRoomToken(h.ids.ownerPort, h.ids.ownerId, roomPath);
    saveRoomToken(slot, roomPath, token);
    h.sendRoomRequest.mockResolvedValue({
      result: "error",
      code: "not_a_member",
    } satisfies ManageOutcome);
    await expect(
      h.lifecycle.leaveRoom(roomPath, h.ids.ownerId),
    ).rejects.toMatchObject({
      message: `Leaving ${roomPath} failed (not_a_member)`,
      code: "LEAVE_FAILED",
    });
  });

  it("leaveRemoteRoom deletes the persisted token and every local record on success", async () => {
    const h = await makeHarness();
    const roomPath = ownerNamedRoomPath(h.ids.memberId, "r");
    h.deps.rooms.set(roomPath, room({ id: roomPath, owner: h.ids.memberId }));
    h.deps.messages.set(roomPath, []);
    const { slot } = h.deps.requireIdentity();
    const token = await mintRoomToken(h.ids.ownerPort, h.ids.ownerId, roomPath);
    saveRoomToken(slot, roomPath, token);
    h.sendRoomRequest.mockResolvedValue({
      result: "ok",
    } satisfies ManageOutcome);
    await h.lifecycle.leaveRoom(roomPath, h.ids.ownerId);
    expect(loadRoomTokens(slot)[roomPath]).toBeUndefined();
    expect(h.deps.rooms.has(roomPath)).toBe(false);
    expect(h.deps.messages.has(roomPath)).toBe(false);
  });
});

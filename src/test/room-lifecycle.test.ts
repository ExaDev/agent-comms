/**
 * Direct, DI-based unit tests for RoomLifecycle -- room CRUD and the requester's own outbound half of the wire protocol, split across two files to stay under this repo's max-lines cap: this file covers createRoom, listRooms, joinRoom/joinRemoteRoom, refreshRoomMembers, and requestDmAccess. See room-lifecycle-membership.test.ts for getRoom and leaveRoom/leaveRemoteRoom (both moved there to rebalance line counts after later gap-closing passes), inviteToRoom, declineInvite, revokeMemberGrant, kickFromRoom, and destroyRoom, and its own copy of this header for the full rationale. Real identities and real minted tokens throughout (not opaque placeholders): RoomLifecycle genuinely mints capability tokens and parses roomJoinOkSchema/roomMembersOkSchema's own structural shape (a real COSE_Sign1 tuple, though never signature-verified by this class), so an arbitrary placeholder string fails the schema outright where room-messaging.test.ts's forwarding-only case could get away with one.
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
  loadRoomTokens,
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

describe("RoomLifecycle — createRoom", () => {
  it("mints and persists the owner's own root grant", async () => {
    const h = await makeHarness();
    const created = await h.lifecycle.createRoom({
      name: "My Room",
      type: "public",
      owner: h.ids.ownerId,
      description: "a room",
    });
    const { slot } = h.deps.requireIdentity();
    expect(loadRoomTokens(slot)[created.id]).toBeDefined();
  });

  it("slugs the given name into the room-path grammar", async () => {
    const h = await makeHarness();
    const created = await h.lifecycle.createRoom({
      name: "My Cool Room!",
      type: "public",
      owner: h.ids.ownerId,
      description: "",
    });
    expect(created.name).toBe("My-Cool-Room");
  });

  it("prefixes the local name with an underscore for a secret room", async () => {
    const h = await makeHarness();
    const created = await h.lifecycle.createRoom({
      name: "hidden",
      type: "secret",
      owner: h.ids.ownerId,
      description: "",
    });
    expect(created.id).toBe(ownerNamedRoomPath(h.ids.ownerId, "_hidden"));
  });

  it("throws ROOM_EXISTS naming the exact id when the room already exists", async () => {
    const h = await makeHarness();
    await h.lifecycle.createRoom({
      name: "dup",
      type: "public",
      owner: h.ids.ownerId,
      description: "",
    });
    const id = ownerNamedRoomPath(h.ids.ownerId, "dup");
    await expect(
      h.lifecycle.createRoom({
        name: "dup",
        type: "public",
        owner: h.ids.ownerId,
        description: "",
      }),
    ).rejects.toMatchObject({
      message: `Room ${id} already exists`,
      code: "ROOM_EXISTS",
    });
  });

  it("defaults federated to false when omitted", async () => {
    const h = await makeHarness();
    const created = await h.lifecycle.createRoom({
      name: "r",
      type: "public",
      owner: h.ids.ownerId,
      description: "",
    });
    expect(created.federated).toBe(false);
  });

  it("honours an explicit federated: true", async () => {
    const h = await makeHarness();
    const created = await h.lifecycle.createRoom({
      name: "r",
      type: "public",
      owner: h.ids.ownerId,
      description: "",
      federated: true,
    });
    expect(created.federated).toBe(true);
  });

  it("seeds an empty message history and broadcasts a room_upsert", async () => {
    const h = await makeHarness();
    const created = await h.lifecycle.createRoom({
      name: "r",
      type: "public",
      owner: h.ids.ownerId,
      description: "",
    });
    expect(h.deps.messages.get(created.id)).toEqual([]);
    expect(h.broadcastPatch).toHaveBeenCalledWith({
      type: "room_upsert",
      room: created,
    });
  });

  it("seeds members/memberJoins with exactly the owner", async () => {
    const h = await makeHarness();
    const created = await h.lifecycle.createRoom({
      name: "r",
      type: "public",
      owner: h.ids.ownerId,
      description: "",
    });
    expect(created.members).toEqual([h.ids.ownerId]);
    expect(created.memberJoins).toEqual({ [h.ids.ownerId]: 1 });
  });
});

describe("RoomLifecycle — listRooms", () => {
  it("includes public and private rooms regardless of membership", async () => {
    const h = await makeHarness();
    h.deps.rooms.set("pub", room({ id: "pub", type: "public", members: [] }));
    h.deps.rooms.set(
      "priv",
      room({ id: "priv", type: "private", members: [] }),
    );
    const result = await h.lifecycle.listRooms(h.ids.memberId);
    expect(result.map((r) => r.id).sort()).toEqual(["priv", "pub"]);
  });

  it("excludes a secret room the requester is not a member of", async () => {
    const h = await makeHarness();
    h.deps.rooms.set(
      "sec",
      room({ id: "sec", type: "secret", members: [h.ids.ownerId] }),
    );
    const result = await h.lifecycle.listRooms(h.ids.memberId);
    expect(result).toEqual([]);
  });

  it("includes a secret room the requester is a member of", async () => {
    const h = await makeHarness();
    h.deps.rooms.set(
      "sec",
      room({ id: "sec", type: "secret", members: [h.ids.memberId] }),
    );
    const result = await h.lifecycle.listRooms(h.ids.memberId);
    expect(result.map((r) => r.id)).toEqual(["sec"]);
  });
});

describe("RoomLifecycle — joinRoom / joinRemoteRoom", () => {
  it("goes remote when this store's own agent has no local token, even if a local room record exists", async () => {
    const h = await makeHarness();
    const roomPath = ownerNamedRoomPath(h.ids.memberId, "shared");
    h.deps.rooms.set(roomPath, room({ id: roomPath, owner: h.ids.memberId }));
    const token = await mintRoomToken(h.ids.ownerPort, h.ids.ownerId, roomPath);
    h.sendRoomRequest.mockResolvedValue(
      roomJoinOkOutcome(token, [h.ids.ownerId]),
    );
    await h.lifecycle.joinRoom(roomPath, h.ids.ownerId);
    expect(h.sendRoomRequest).toHaveBeenCalled();
  });

  it("skips the remote round trip when a local token already exists and the room is known", async () => {
    const h = await makeHarness();
    const roomPath = ownerNamedRoomPath(h.ids.memberId, "shared");
    h.deps.rooms.set(
      roomPath,
      room({
        id: roomPath,
        owner: h.ids.memberId,
        members: [h.ids.memberId],
        memberJoins: { [h.ids.memberId]: 1 },
      }),
    );
    const { slot } = h.deps.requireIdentity();
    const token = await mintRoomToken(h.ids.ownerPort, h.ids.ownerId, roomPath);
    saveRoomToken(slot, roomPath, token);
    await h.lifecycle.joinRoom(roomPath, h.ids.ownerId);
    expect(h.sendRoomRequest).not.toHaveBeenCalled();
  });

  it("always takes the local CRDT path for an agent other than this store's own peer, regardless of tokens", async () => {
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
    await h.lifecycle.joinRoom("room-1", h.ids.memberId);
    expect(h.sendRoomRequest).not.toHaveBeenCalled();
    expect(h.deps.rooms.get("room-1")?.members).toContain(h.ids.memberId);
  });

  it("goes remote when the room isn't known locally at all", async () => {
    const h = await makeHarness();
    const roomPath = ownerNamedRoomPath(h.ids.memberId, "unseen");
    const token = await mintRoomToken(h.ids.ownerPort, h.ids.ownerId, roomPath);
    h.sendRoomRequest.mockResolvedValue(
      roomJoinOkOutcome(token, [h.ids.ownerId]),
    );
    await h.lifecycle.joinRoom(roomPath, h.ids.ownerId);
    expect(h.sendRoomRequest).toHaveBeenCalled();
  });

  it("joinRemoteRoom throws ROOM_NOT_FOUND when joining on behalf of a different agent", async () => {
    const h = await makeHarness();
    const roomPath = ownerNamedRoomPath(h.ids.memberId, "unseen");
    await expect(
      h.lifecycle.joinRoom(roomPath, h.ids.memberId),
    ).rejects.toMatchObject({ code: "ROOM_NOT_FOUND" });
    // (h.ids.memberId isn't this store's own peer, so joinRemoteRoom's own agentId-mismatch guard fires.)
  });

  it("joinRemoteRoom throws ROOM_NOT_FOUND for a non-owner-named path (e.g. a DM path)", async () => {
    const h = await makeHarness();
    const dmPath = dmRoomPath(h.ids.ownerId, h.ids.memberId);
    await expect(
      h.lifecycle.joinRoom(dmPath, h.ids.ownerId),
    ).rejects.toMatchObject({ code: "ROOM_NOT_FOUND" });
  });

  it("joinRemoteRoom throws JOIN_REFUSED naming the outcome code on a non-ok outcome", async () => {
    const h = await makeHarness();
    const roomPath = ownerNamedRoomPath(h.ids.memberId, "unseen");
    h.sendRoomRequest.mockResolvedValue({
      result: "error",
      code: "not_invited",
    } satisfies ManageOutcome);
    await expect(
      h.lifecycle.joinRoom(roomPath, h.ids.ownerId),
    ).rejects.toMatchObject({
      message: `Join request for ${roomPath} was refused (not_invited)`,
      code: "JOIN_REFUSED",
    });
  });

  it("joinRemoteRoom throws MALFORMED_RESPONSE when the outcome fails the roomJoinOk schema", async () => {
    const h = await makeHarness();
    const roomPath = ownerNamedRoomPath(h.ids.memberId, "unseen");
    h.sendRoomRequest.mockResolvedValue({
      result: "ok",
      nonsense: true,
    });
    await expect(
      h.lifecycle.joinRoom(roomPath, h.ids.ownerId),
    ).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  });

  it("joinRemoteRoom persists the granted token and builds the room from the response", async () => {
    const h = await makeHarness();
    const roomPath = ownerNamedRoomPath(h.ids.memberId, "unseen");
    const token = await mintRoomToken(h.ids.ownerPort, h.ids.ownerId, roomPath);
    h.sendRoomRequest.mockResolvedValue(
      roomJoinOkOutcome(token, [h.ids.ownerId, h.ids.memberId], {
        "room-state": {
          name: "real-name",
          description: "real-desc",
          type: "private",
        },
      }),
    );
    await h.lifecycle.joinRoom(roomPath, h.ids.ownerId);
    const stored = h.deps.rooms.get(roomPath);
    expect(stored?.name).toBe("real-name");
    expect(stored?.type).toBe("private");
    expect(stored?.members.sort()).toEqual(
      [h.ids.ownerId, h.ids.memberId].sort(),
    );
    const { slot } = h.deps.requireIdentity();
    expect(loadRoomTokens(slot)[roomPath]).toBeDefined();
  });

  it("joinRemoteRoom falls back to public/localName/empty-description when no room-state extension is present", async () => {
    const h = await makeHarness();
    const roomPath = ownerNamedRoomPath(h.ids.memberId, "unseen");
    const token = await mintRoomToken(h.ids.ownerPort, h.ids.ownerId, roomPath);
    h.sendRoomRequest.mockResolvedValue(
      roomJoinOkOutcome(token, [h.ids.ownerId]),
    );
    await h.lifecycle.joinRoom(roomPath, h.ids.ownerId);
    const stored = h.deps.rooms.get(roomPath);
    expect(stored?.type).toBe("public");
    expect(stored?.name).toBe("unseen");
    expect(stored?.description).toBe("");
  });

  it("throws NOT_INVITED for a non-public room the joiner isn't invited to and doesn't own", async () => {
    const h = await makeHarness();
    h.deps.rooms.set(
      "room-1",
      room({
        id: "room-1",
        type: "private",
        owner: h.ids.ownerId,
        members: [],
      }),
    );
    await expect(
      h.lifecycle.joinRoom("room-1", h.ids.memberId),
    ).rejects.toMatchObject({
      message: "Not invited to room room-1",
      code: "NOT_INVITED",
    });
  });

  it("allows joining a private room when invited", async () => {
    const h = await makeHarness();
    h.deps.rooms.set(
      "room-1",
      room({
        id: "room-1",
        type: "private",
        owner: h.ids.ownerId,
        members: [],
        invited: [h.ids.memberId],
        invitedJoins: { [h.ids.memberId]: 1 },
      }),
    );
    await expect(
      h.lifecycle.joinRoom("room-1", h.ids.memberId),
    ).resolves.toBeDefined();
  });

  it("allows the room's own owner to join a private room without being separately invited", async () => {
    const h = await makeHarness();
    h.deps.rooms.set(
      "room-1",
      room({
        id: "room-1",
        type: "private",
        owner: h.ids.memberId,
        members: [],
      }),
    );
    await expect(
      h.lifecycle.joinRoom("room-1", h.ids.memberId),
    ).resolves.toBeDefined();
  });

  it("retires the invited entry when consuming an invitation", async () => {
    const h = await makeHarness();
    h.deps.rooms.set(
      "room-1",
      room({
        id: "room-1",
        type: "private",
        owner: h.ids.ownerId,
        members: [],
        invited: [h.ids.memberId],
        invitedJoins: { [h.ids.memberId]: 1 },
      }),
    );
    await h.lifecycle.joinRoom("room-1", h.ids.memberId);
    expect(h.deps.rooms.get("room-1")?.invited).not.toContain(h.ids.memberId);
  });

  it("does not touch the invited list for a fresh join to an already-public room", async () => {
    const h = await makeHarness();
    h.deps.rooms.set(
      "room-1",
      room({ id: "room-1", type: "public", owner: h.ids.ownerId, members: [] }),
    );
    await h.lifecycle.joinRoom("room-1", h.ids.memberId);
    expect(h.recordMemberOp).not.toHaveBeenCalledWith(
      expect.anything(),
      "invited",
      "leave",
      h.ids.memberId,
    );
  });

  it("updates subscribedRooms and broadcasts agent_upsert only for a known agent not already subscribed", async () => {
    const h = await makeHarness();
    h.deps.rooms.set(
      "room-1",
      room({ id: "room-1", type: "public", owner: h.ids.ownerId, members: [] }),
    );
    h.deps.agents.set(
      h.ids.memberId,
      agent({ id: h.ids.memberId, subscribedRooms: [] }),
    );
    await h.lifecycle.joinRoom("room-1", h.ids.memberId);
    expect(h.deps.agents.get(h.ids.memberId)?.subscribedRooms).toContain(
      "room-1",
    );
    expect(h.broadcastPatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "agent_upsert" }),
    );
  });

  it("skips the agent_upsert broadcast when the joining agent has no local record", async () => {
    const h = await makeHarness();
    h.deps.rooms.set(
      "room-1",
      room({ id: "room-1", type: "public", owner: h.ids.ownerId, members: [] }),
    );
    await h.lifecycle.joinRoom("room-1", h.ids.memberId);
    expect(h.broadcastPatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "agent_upsert" }),
    );
  });

  it("delivers a room_members list built only from agents actually present locally", async () => {
    const h = await makeHarness();
    h.deps.rooms.set(
      "room-1",
      room({
        id: "room-1",
        type: "public",
        owner: h.ids.ownerId,
        members: [h.ids.ownerId],
        memberJoins: { [h.ids.ownerId]: 1 },
      }),
    );
    h.deps.agents.set(
      h.ids.ownerId,
      agent({ id: h.ids.ownerId, name: "owner" }),
    );
    await h.lifecycle.joinRoom("room-1", h.ids.memberId);
    expect(h.deliverLocallyAndBroadcast).toHaveBeenCalledWith(
      h.ids.memberId,
      expect.objectContaining({
        type: "room_members",
        members: [expect.objectContaining({ id: h.ids.ownerId })],
      }),
    );
  });

  it("notifies existing room members of the join, excluding the joiner itself", async () => {
    const h = await makeHarness();
    h.deps.rooms.set(
      "room-1",
      room({ id: "room-1", type: "public", owner: h.ids.ownerId, members: [] }),
    );
    await h.lifecycle.joinRoom("room-1", h.ids.memberId);
    expect(h.deliverToRoom).toHaveBeenCalledWith(
      "room-1",
      expect.objectContaining({ type: "member_joined", agent: h.ids.memberId }),
      h.ids.memberId,
    );
  });

  it("notifies federated links only when the room is federated", async () => {
    const federated = await makeHarness();
    federated.deps.rooms.set(
      "room-1",
      room({
        id: "room-1",
        type: "public",
        owner: federated.ids.ownerId,
        members: [],
        federated: true,
      }),
    );
    await federated.lifecycle.joinRoom("room-1", federated.ids.memberId);
    expect(federated.broadcastRoomJoin).toHaveBeenCalledTimes(1);

    const plain = await makeHarness();
    plain.deps.rooms.set(
      "room-1",
      room({
        id: "room-1",
        type: "public",
        owner: plain.ids.ownerId,
        members: [],
        federated: false,
      }),
    );
    await plain.lifecycle.joinRoom("room-1", plain.ids.memberId);
    expect(plain.broadcastRoomJoin).not.toHaveBeenCalled();
  });
});

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
    ).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  });

  it("starts the version at 1 with no existing local copy", async () => {
    const h = await makeHarness();
    const roomPath = ownerNamedRoomPath(h.ids.memberId, "r");
    const { slot } = h.deps.requireIdentity();
    const token = await mintRoomToken(h.ids.ownerPort, h.ids.ownerId, roomPath);
    saveRoomToken(slot, roomPath, token);
    h.sendRoomRequest.mockResolvedValue(roomMembersOkOutcome([h.ids.ownerId]));
    const refreshed = await h.lifecycle.refreshRoomMembers(roomPath);
    expect(refreshed.version).toBe(1);
  });

  it("increments the version relative to the existing local copy", async () => {
    const h = await makeHarness();
    const roomPath = ownerNamedRoomPath(h.ids.memberId, "r");
    h.deps.rooms.set(roomPath, room({ id: roomPath, version: 1 }));
    const { slot } = h.deps.requireIdentity();
    const token = await mintRoomToken(h.ids.ownerPort, h.ids.ownerId, roomPath);
    saveRoomToken(slot, roomPath, token);
    h.sendRoomRequest.mockResolvedValue(roomMembersOkOutcome([h.ids.ownerId]));
    const refreshed = await h.lifecycle.refreshRoomMembers(roomPath);
    expect(refreshed.version).toBe(2);
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
    ).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
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

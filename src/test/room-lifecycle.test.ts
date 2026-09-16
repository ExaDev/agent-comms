/**
 * Direct, DI-based unit tests for RoomLifecycle -- room CRUD and the requester's own outbound half of the wire protocol, split across three files to stay under this repo's max-lines cap: this file covers createRoom, listRooms, and joinRoom/joinRemoteRoom. See room-lifecycle-remote.test.ts for refreshRoomMembers/requestDmAccess and room-lifecycle-membership.test.ts for getRoom/leaveRoom/leaveRemoteRoom/inviteToRoom/declineInvite/revokeMemberGrant/kickFromRoom/destroyRoom (both moved out to rebalance line counts after later gap-closing passes). Real identities and real minted tokens throughout (not opaque placeholders): RoomLifecycle genuinely mints capability tokens and parses roomJoinOkSchema/roomMembersOkSchema's own structural shape (a real COSE_Sign1 tuple, though never signature-verified by this class), so an arbitrary placeholder string fails the schema outright where room-messaging.test.ts's forwarding-only case could get away with one.
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
  deliverToMember: ReturnType<typeof vi.fn>;
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
  const deliverToMember = vi.fn().mockResolvedValue(undefined);
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
      deliverToMember,
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
    deliverToMember,
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

// mintOwnerRootGrant's `if (!verdict.ok)` failure branch (and the two StringLiteral mutants Stryker raises inside its error message) is genuinely unreachable with the real crypto this test suite uses throughout: mintCapabilityToken only fails its own internal delegation-narrowing checks, and a parent-less, delegationsRemaining:0 root mint against a validly-generated identity has no narrowing to fail. Forcing a failure here would need either a fake identity port (defeating the whole point of using real crypto to catch real signature/schema bugs elsewhere in this file) or reaching into mintCapabilityToken's own internals -- left undocumented-but-untested rather than chased with a contrived fixture, matching this session's own diminishing-returns precedent for similarly unreachable mint-failure branches.
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

  it("merges in a gossip-discovered room not otherwise locally known, as a placeholder-shaped Room", async () => {
    const h = await makeHarness();
    h.deps.requireTransport = () =>
      ({
        listKnownDevices: () => [
          {
            deviceId: h.ids.ownerId,
            advert: {
              "room/hosted": [
                {
                  path: "discovered-room",
                  name: "discovered",
                  type: "public",
                  description: "found via gossip",
                },
              ],
            },
          },
        ],
      }) as unknown as ReturnType<RoomLifecycleDeps["requireTransport"]>;

    const result = await h.lifecycle.listRooms(h.ids.memberId);
    const discovered = result.find((r) => r.id === "discovered-room");
    expect(discovered).toMatchObject({
      id: "discovered-room",
      name: "discovered",
      type: "public",
      owner: h.ids.ownerId,
      description: "found via gossip",
      members: [],
    });
  });

  it("never lets a gossip-discovered room shadow a room this store already knows locally", async () => {
    const h = await makeHarness();
    h.deps.rooms.set(
      "already-known",
      room({ id: "already-known", type: "public", description: "real" }),
    );
    h.deps.requireTransport = () =>
      ({
        listKnownDevices: () => [
          {
            deviceId: h.ids.ownerId,
            advert: {
              "room/hosted": [
                {
                  path: "already-known",
                  name: "stale-gossip-copy",
                  type: "public",
                  description: "gossip",
                },
              ],
            },
          },
        ],
      }) as unknown as ReturnType<RoomLifecycleDeps["requireTransport"]>;

    const result = await h.lifecycle.listRooms(h.ids.memberId);
    expect(result.filter((r) => r.id === "already-known")).toHaveLength(1);
    expect(result.find((r) => r.id === "already-known")?.description).toBe(
      "real",
    );
  });

  it("ignores a transport with no listKnownDevices capability, matching every construction site that predates this feature", async () => {
    const h = await makeHarness();
    h.deps.rooms.set("pub", room({ id: "pub", type: "public" }));
    const result = await h.lifecycle.listRooms(h.ids.memberId);
    expect(result.map((r) => r.id)).toEqual(["pub"]);
  });
});

// joinRoom's own `this.deps.rooms.set(roomId, room)` and `this.deps.agents.set(agentId, agent)` calls each have one provable equivalent mutant Stryker still raises: removing them. Both `room` and `agent` are the same object references already fetched via `.get()`, and every mutation up to each call (bump/recordMemberOp/refreshMembership for room; push/bump for agent) already happened in place on that reference -- so re-setting the map entry to the identical reference it already holds changes nothing observable, the same Map.set-same-reference pattern documented throughout this repo's own mutation-testing work (agent-registry.ts's setAgentOffline, delivery-engine.ts's applyPatch(agent_offline)).
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
    ).rejects.toMatchObject({
      message: `Room ${roomPath} not found`,
      code: "ROOM_NOT_FOUND",
    });
    // (h.ids.memberId isn't this store's own peer, so joinRemoteRoom's own agentId-mismatch guard fires.)
  });

  it("joinRemoteRoom throws ROOM_NOT_FOUND for a non-owner-named path (e.g. a DM path)", async () => {
    const h = await makeHarness();
    const dmPath = dmRoomPath(h.ids.ownerId, h.ids.memberId);
    await expect(
      h.lifecycle.joinRoom(dmPath, h.ids.ownerId),
    ).rejects.toMatchObject({
      message: `Room ${dmPath} not found`,
      code: "ROOM_NOT_FOUND",
    });
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
    ).rejects.toMatchObject({
      message: `Join response for ${roomPath} was malformed`,
      code: "MALFORMED_RESPONSE",
    });
  });

  it("joinRemoteRoom persists the granted token and builds the room from the response, including its memberJoins", async () => {
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
    expect(stored?.memberJoins).toEqual({
      [h.ids.ownerId]: 1,
      [h.ids.memberId]: 1,
    });
    expect(stored?.federated).toBe(false);
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

  it("updates subscribedRooms, bumps the agent's version, and broadcasts agent_upsert only for a known agent not already subscribed", async () => {
    const h = await makeHarness();
    h.deps.rooms.set(
      "room-1",
      room({ id: "room-1", type: "public", owner: h.ids.ownerId, members: [] }),
    );
    h.deps.agents.set(
      h.ids.memberId,
      agent({ id: h.ids.memberId, subscribedRooms: [], version: 1 }),
    );
    await h.lifecycle.joinRoom("room-1", h.ids.memberId);
    const updated = h.deps.agents.get(h.ids.memberId);
    expect(updated?.subscribedRooms).toContain("room-1");
    expect(updated?.version).toBe(2);
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
    expect(h.deliverToMember).toHaveBeenCalledWith(
      h.ids.memberId,
      "room-1",
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

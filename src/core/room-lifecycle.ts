/**
 * RoomLifecycle — room CRUD and the requester's own outbound half of the wire protocol: create/get/list, join/leave (local CRDT mutation for an already-known room, or a real wire-level room.join/room.leave round trip via joinRemoteRoom/leaveRemoteRoom when this store's own identity isn't yet admitted), invite/decline, membership-grant revocation, kick, and destroy. Split out of mesh-store.ts to reduce it under the repo's max-lines cap.
 */

import {
  deviceIdFromHex,
  deviceIdToHex,
} from "wire-mesh-core/domain/device-id";
import {
  mintCapabilityToken,
  mintRevocationEntry,
} from "wire-mesh-core/domain/tokens";
import {
  roomJoinOkSchema,
  roomMembersOkSchema,
} from "wire-mesh-core/generated/protocol";
import {
  dmRoomPath,
  ownerNamedRoomPath,
  parseRoomPath,
  slugRoomName,
} from "./room-path.js";
import {
  ROOM_MEMBER_CAPABILITY,
  ROOM_MEMBER_DELEGATION_POLICY,
} from "./room-token-verification.js";
import { DM_SEND_CAPABILITY } from "./dm-token-verification.js";
import { resolveDelegationsRemaining } from "./delegation-policy.js";
import {
  deleteIssuedRoomGrant,
  deleteRoomToken,
  loadIssuedRoomGrant,
  loadRoomTokens,
  saveIssuedRoomGrant,
  saveRoomToken,
} from "./identity-store.js";
import {
  deleteIssuedDmGrant,
  loadIssuedDmGrant,
  saveIssuedDmGrant,
} from "./user-identity.js";
import { randomId } from "./random-id.js";
import { resolveRoomId } from "./room-lookup.js";
import { CommsError } from "./store.js";
import {
  DM_SEND_GRANT_LIFETIME_MS,
  ROOM_TOKEN_LIFETIME_MS,
} from "./mesh-store-shared.js";
import type { MeshStoreIdentity } from "./mesh-store-shared.js";
import {
  inviterAgentExtension,
  parseRoomStateExtension,
  roomStateExtension,
} from "./room-wire-extensions.js";
import type { DeliveryEngine } from "./delivery-engine.js";
import type { MeshTransport } from "./transport.js";
import type { HostedRoomAdvert } from "./wire-mesh-transport.js";
import type { CapabilityToken } from "wire-mesh-core/generated/protocol";
import type {
  AgentIdentity,
  AgentStatus,
  Room,
  RoomMessage,
  RoomType,
} from "./types.js";

/** Narrows an untrusted gossiped value (WireMeshTransport.listKnownDevices' own advert["room/hosted"], self-asserted by whichever peer advertised it) into a HostedRoomAdvert -- a malformed or non-conforming entry is silently skipped rather than treated as an error, the same convention presence/status' own gossip consumption already established: this is a discovery hint over self-asserted data, not a security check. */
function isHostedRoomAdvert(value: unknown): value is HostedRoomAdvert {
  if (typeof value !== "object" || value === null) return false;
  if (!("path" in value) || typeof value.path !== "string") return false;
  if (!("name" in value) || typeof value.name !== "string") return false;
  if (
    !("type" in value) ||
    (value.type !== "public" && value.type !== "private")
  )
    return false;
  if (!("description" in value) || typeof value.description !== "string")
    return false;
  return true;
}

/** The state and collaborators RoomLifecycle needs from MeshStore. rooms/messages/agents/dmRequestsInitiatedByMe are direct references into MeshStore's own fields (dmRequestsInitiatedByMe shared with RoomProtocol, which reads what requestDmAccess writes here); deliveryEngine is the already-constructed instance, narrowed to what room CRUD ever needs. */
export interface RoomLifecycleDeps {
  rooms: Map<string, Room>;
  messages: Map<string, RoomMessage[]>;
  agents: Map<string, AgentIdentity>;
  dmRequestsInitiatedByMe: Set<string>;
  getPeerId: () => string;
  requireIdentity: () => MeshStoreIdentity;
  requireTransport: () => MeshTransport;
  deliveryEngine: Pick<
    DeliveryEngine,
    | "bump"
    | "recordMemberOp"
    | "refreshMembership"
    | "broadcastPatch"
    | "deliverToRoom"
    | "deliverToMember"
  >;
}

export class RoomLifecycle {
  constructor(private readonly deps: RoomLifecycleDeps) {}

  /**
   * Mints and persists the room owner's own self-signed room:member grant: issuer = bearer = owner, no parent, delegationsRemaining: 0. This is deliberately NOT the parent every later member grant chains through -- a delegations-remaining: 0 parent cannot mint any child at all (mintCapabilityToken refuses a child whose own delegationsRemaining isn't strictly less than its parent's, and there is no value less than 0), so a later join/invite grant is its own independent, parent-less, owner-issued root-level token instead (still satisfying the "chain roots at the path's own owner" obligation, since rootIssuer is just the token's own issuer when it carries no parent). This root grant exists purely so the owner has a token to present for its own room actions, uniformly with every other member, per the design's own "every code path that checks membership does the same thing regardless of who it is checking" reasoning.
   */
  private async mintOwnerRootGrant(
    roomPath: string,
    owner: string,
  ): Promise<void> {
    const { identity, clock, slot } = this.deps.requireIdentity();
    const verdict = await mintCapabilityToken({
      identity,
      clock,
      tokenId: randomId(),
      bearer: deviceIdFromHex(owner),
      capability: ROOM_MEMBER_CAPABILITY,
      scope: { kind: "room", path: roomPath },
      expires: clock.now() + ROOM_TOKEN_LIFETIME_MS,
      delegationsRemaining: resolveDelegationsRemaining(
        ROOM_MEMBER_DELEGATION_POLICY,
        ROOM_MEMBER_CAPABILITY,
        owner,
        0,
      ),
    });
    if (!verdict.ok) {
      throw new Error(
        `MeshStore: failed to mint room owner grant for ${roomPath}: ${verdict.reason}`,
      );
    }
    saveRoomToken(slot, roomPath, verdict.token);
  }

  async createRoom(
    opts: Readonly<{
      name: string;
      type: RoomType;
      owner: string;
      description: string;
    }>,
  ): Promise<Room> {
    // slugRoomName sanitises an arbitrary caller-supplied name (e.g. from a live create_room tool call, not just an internal cwd basename) into the room-path grammar's [A-Za-z0-9_-]+ charset -- createRoom is the one choke point every room creation goes through, so this is the right place to do it rather than trusting every caller to have pre-slugged, the way the old bare-name id never required at all.
    const slugName = slugRoomName(opts.name);
    const localName = opts.type === "secret" ? `_${slugName}` : slugName;
    const id = ownerNamedRoomPath(opts.owner, localName);
    if (this.deps.rooms.has(id))
      throw new CommsError(`Room ${id} already exists`, "ROOM_EXISTS");

    // Every room creation this store performs is local: opts.owner is always this bridge's own identity (create_room's caller passes ctx.agentId, and one bridge process is one agent is one device), so minting the owner's own root grant here always signs under the identity this store was wired with, never someone else's.
    await this.mintOwnerRootGrant(id, opts.owner);

    const room: Room = {
      id,
      version: 1,
      name: slugName,
      type: opts.type,
      owner: opts.owner,
      createdAt: new Date().toISOString(),
      description: opts.description,
      members: [opts.owner],
      invited: [],
      memberJoins: { [opts.owner]: 1 },
      memberLeaves: {},
      invitedJoins: {},
      invitedLeaves: {},
    };

    this.deps.rooms.set(id, room);
    this.deps.messages.set(id, []);
    await this.deps.deliveryEngine.broadcastPatch({
      type: "room_upsert",
      room,
    });
    return room;
  }

  async getRoom(id: string): Promise<Room | undefined> {
    await Promise.resolve();
    return this.deps.rooms.get(id);
  }

  async listRooms(requesterId: string): Promise<Room[]> {
    await Promise.resolve();
    const result: Room[] = [];
    for (const room of this.deps.rooms.values()) {
      if (room.type === "secret" && !room.members.includes(requesterId))
        continue;
      result.push(room);
    }
    for (const discovered of this.listDiscoverableRooms()) {
      if (this.deps.rooms.has(discovered.path)) continue;
      result.push({
        id: discovered.path,
        version: 0,
        name: discovered.name,
        type: discovered.type,
        owner: discovered.ownerDeviceId,
        createdAt: "",
        description: discovered.description,
        members: [],
        invited: [],
        memberJoins: {},
        memberLeaves: {},
        invitedJoins: {},
        invitedLeaves: {},
      });
    }
    return result;
  }

  /**
   * Every public/private room this store has heard gossiped by another device but never joined or otherwise locally recorded -- the read half of P3.8's room-discovery replacement for createRoom's own broadcastPatch (agent-comms#48/#50). Never merged into this.deps.rooms: a gossip hint is not membership, and a room this store was never admitted to has nothing real to synthesize beyond what the advert itself carries. Secret rooms never need filtering here the way listRooms' own local-room check needs -- HostedRoomAdvert's own type field is restricted to "public" | "private" at the source (WireMeshTransport's getHostedRooms), so a secret room is never gossiped under this key at all.
   */
  private listDiscoverableRooms(): readonly (HostedRoomAdvert & {
    ownerDeviceId: string;
  })[] {
    const transport = this.deps.requireTransport();
    if (transport.listKnownDevices === undefined) return [];
    const result: (HostedRoomAdvert & { ownerDeviceId: string })[] = [];
    for (const { deviceId, advert } of transport.listKnownDevices()) {
      const hosted = advert["room/hosted"];
      if (!Array.isArray(hosted)) continue;
      for (const candidate of hosted) {
        if (!isHostedRoomAdvert(candidate)) continue;
        result.push({ ...candidate, ownerDeviceId: deviceId });
      }
    }
    return result;
  }

  /**
   * The remote-join path: roomPath names an owner-named room this store has never seen replicated, so joining it means sending a real wire-level room.join request to the room's own owner and persisting whatever grant comes back, rather than mutating already-known local state. Only ever called for this store's own local agent (one bridge is one agent is one device, per the design's own organising fact) -- there is no wire mechanism by which this node could join a room on a different local agent's behalf.
   */
  private async joinRemoteRoom(
    roomPath: string,
    agentId: string,
  ): Promise<Room> {
    if (agentId !== this.deps.getPeerId()) {
      throw new CommsError(`Room ${roomPath} not found`, "ROOM_NOT_FOUND");
    }
    const parsed = parseRoomPath(roomPath);
    if (parsed.kind !== "owner-named") {
      throw new CommsError(`Room ${roomPath} not found`, "ROOM_NOT_FOUND");
    }

    const outcome = await this.deps
      .requireTransport()
      .sendRoomRequest(
        parsed.owner,
        { verb: ROOM_MEMBER_CAPABILITY, params: { verb: "room.join" } },
        { kind: "room", path: roomPath },
      );
    if (outcome.result !== "ok") {
      throw new CommsError(
        `Join request for ${roomPath} was refused (${outcome.code})`,
        "JOIN_REFUSED",
      );
    }
    const parsedOutcome = roomJoinOkSchema.safeParse(outcome);
    if (!parsedOutcome.success) {
      throw new CommsError(
        `Join response for ${roomPath} was malformed`,
        "MALFORMED_RESPONSE",
      );
    }
    const { "granted-token": grantedToken, members: memberList } =
      parsedOutcome.data;

    const { slot } = this.deps.requireIdentity();
    saveRoomToken(slot, roomPath, grantedToken);

    const members = memberList.map((member) => deviceIdToHex(member.device));
    const roomState = parseRoomStateExtension(parsedOutcome.data["room-state"]);
    const room: Room = {
      id: roomPath,
      version: 1,
      name: roomState?.name ?? parsed.localName,
      // Falls back to "public" only against a peer running without the room-state extension (an older version); this joiner is always in `members` by construction regardless, so a stale "public" classification here never hides the room from its own member -- the one place type is read (listRooms' secret-room filter).
      type: roomState?.type ?? "public",
      owner: parsed.owner,
      createdAt: new Date().toISOString(),
      description: roomState?.description ?? "",
      members,
      invited: [],
      memberJoins: Object.fromEntries(members.map((member) => [member, 1])),
      memberLeaves: {},
      invitedJoins: {},
      invitedLeaves: {},
    };
    this.deps.rooms.set(roomPath, room);
    this.deps.messages.set(roomPath, []);
    return room;
  }

  /**
   * Refreshes this store's own local copy of a named room's membership and room-state via a real room.members request (P3.6): the same information room.join's own response carries at admission time, available on demand for a member whose local copy may have drifted (a kick, an invite, a rename since it joined). Sent to the room's own owner, the authoritative source for that room's real state. Named rooms only, matching joinRemoteRoom's own restriction -- a DM's "membership" is already fully known from the path itself (the sorted pair of exactly two participants), and this codebase has no Room-object representation for a DM to refresh into (DM state lives in this.dms, keyed by message history, not this.rooms). Throws if this store holds no room:member token for roomPath -- refreshing membership presupposes already being a member, the same NOT_A_MEMBER contract sendRoomMessageDirected already uses.
   */
  async refreshRoomMembers(roomPath: string): Promise<Room> {
    const parsed = parseRoomPath(roomPath);
    if (parsed.kind !== "owner-named") {
      throw new CommsError(`Room ${roomPath} not found`, "ROOM_NOT_FOUND");
    }
    const { slot } = this.deps.requireIdentity();
    const token = loadRoomTokens(slot)[roomPath];
    if (token === undefined) {
      throw new CommsError(
        `No room:member token for ${roomPath}`,
        "NOT_MEMBER",
      );
    }

    const outcome = await this.deps
      .requireTransport()
      .sendRoomRequest(
        parsed.owner,
        { verb: ROOM_MEMBER_CAPABILITY, params: { verb: "room.members" } },
        { kind: "room", path: roomPath },
        token,
      );
    if (outcome.result !== "ok") {
      throw new CommsError(
        `room.members refresh for ${roomPath} failed (${outcome.code})`,
        "REFRESH_FAILED",
      );
    }
    const parsedOutcome = roomMembersOkSchema.safeParse(outcome);
    if (!parsedOutcome.success) {
      throw new CommsError(
        `room.members response for ${roomPath} was malformed`,
        "MALFORMED_RESPONSE",
      );
    }
    const members = parsedOutcome.data.members.map((member) =>
      deviceIdToHex(member.device),
    );
    const roomState = parseRoomStateExtension(parsedOutcome.data["room-state"]);

    const existing = this.deps.rooms.get(roomPath);
    const room: Room = {
      id: roomPath,
      version: (existing?.version ?? 0) + 1,
      name: roomState?.name ?? existing?.name ?? parsed.localName,
      type: roomState?.type ?? existing?.type ?? "public",
      owner: parsed.owner,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      description: roomState?.description ?? existing?.description ?? "",
      members,
      invited: existing?.invited ?? [],
      memberJoins: Object.fromEntries(members.map((member) => [member, 1])),
      memberLeaves: {},
      invitedJoins: existing?.invitedJoins ?? {},
      invitedLeaves: existing?.invitedLeaves ?? {},
    };
    this.deps.rooms.set(roomPath, room);
    return room;
  }

  /**
   * The requester's own half of section 6's two-round DM consent flow: sends an ungated room.join scoped to dmRoomPath(this, counterpart) directly to the counterpart, records having initiated it so the counterpart's own reciprocal room.join back auto-approves rather than surfacing as a fresh, unsolicited request, and persists whatever grant comes back. Deliberately outside the CommsStore interface, like connection approval, since it is a wire-mesh-specific concern FileStore has no equivalent for. Safe to call again for the same counterpart later (e.g. after an earlier request expired or was rejected) -- it always sends a fresh request rather than checking for an existing token first.
   *
   * dmSendGrant, when given, is a dm:send capability the counterpart's own user principal minted for this device (agent-comms#162, admitAgentForDm) -- attaching it here lets the counterpart's own handleRoomJoin verify durable, pre-existing admission and auto-admit immediately, without holding this request open for a fresh human decision the way an ungated request otherwise would.
   */
  async requestDmAccess(
    counterpart: string,
    dmSendGrant?: CapabilityToken,
  ): Promise<void> {
    const dmPath = dmRoomPath(this.deps.getPeerId(), counterpart);
    this.deps.dmRequestsInitiatedByMe.add(dmPath);
    const outcome = await this.deps
      .requireTransport()
      .sendRoomRequest(
        counterpart,
        { verb: ROOM_MEMBER_CAPABILITY, params: { verb: "room.join" } },
        { kind: "room", path: dmPath },
        dmSendGrant,
      );
    if (outcome.result !== "ok") {
      throw new CommsError(
        `DM access request to ${counterpart} was refused (${outcome.code})`,
        "JOIN_REFUSED",
      );
    }
    const parsedOutcome = roomJoinOkSchema.safeParse(outcome);
    if (!parsedOutcome.success) {
      throw new CommsError(
        `DM access response from ${counterpart} was malformed`,
        "MALFORMED_RESPONSE",
      );
    }
    const { slot } = this.deps.requireIdentity();
    saveRoomToken(slot, dmPath, parsedOutcome.data["granted-token"]);
  }

  /**
   * Joins a room. For this store's own identity, "already known locally" is not the right gate for skipping real admission: the legacy full-state-sync replicates a room's metadata to every mesh-connected peer the moment it's created, well before that peer has ever been admitted, so a room already present in this.rooms says nothing about whether this store actually holds a valid room:member token for it. The real gate is that token's presence -- absent, this always goes through joinRemoteRoom's real wire-level admission regardless of what this.rooms already knows, so a peer that merely heard about a room never mistakes hearing about it for having joined it. Joining on behalf of a DIFFERENT agentId (this store's own convergence/admin bookkeeping, exercised directly by state-sync-convergence.test.ts) is untouched -- that's a pure local CRDT mutation with no admission concept at all.
   */
  async joinRoom(roomIdOrName: string, agentId: string): Promise<Room> {
    const roomId = resolveRoomId(this.deps.rooms, roomIdOrName);
    const peerId = this.deps.getPeerId();
    if (agentId === peerId) {
      const { slot } = this.deps.requireIdentity();
      if (loadRoomTokens(slot)[roomId] === undefined) {
        return this.joinRemoteRoom(roomId, agentId);
      }
    }
    const room = this.deps.rooms.get(roomId);
    if (!room) return this.joinRemoteRoom(roomId, agentId);

    const alreadyMember = room.members.includes(agentId);
    if (!alreadyMember && room.type !== "public") {
      if (!room.invited.includes(agentId) && room.owner !== agentId) {
        throw new CommsError(`Not invited to room ${roomId}`, "NOT_INVITED");
      }
    }

    this.deps.deliveryEngine.bump(room);
    this.deps.deliveryEngine.recordMemberOp(room, "member", "join", agentId);
    if (alreadyMember || room.type !== "public") {
      // Consuming an invitation (or re-joining) retires the invited entry.
      this.deps.deliveryEngine.recordMemberOp(
        room,
        "invited",
        "leave",
        agentId,
      );
    }
    this.deps.deliveryEngine.refreshMembership(room);
    this.deps.rooms.set(roomId, room);

    const agent = this.deps.agents.get(agentId);
    if (agent && !agent.subscribedRooms.includes(roomId)) {
      agent.subscribedRooms.push(roomId);
      this.deps.deliveryEngine.bump(agent);
      this.deps.agents.set(agentId, agent);
      await this.deps.deliveryEngine.broadcastPatch({
        type: "agent_upsert",
        agent,
      });
    }

    await this.deps.deliveryEngine.broadcastPatch({
      type: "room_upsert",
      room,
    });

    // Send current member list to the joining agent
    const members: { id: string; name: string; status: AgentStatus }[] = [];
    for (const memberId of room.members) {
      const memberAgent = this.deps.agents.get(memberId);
      if (memberAgent) {
        members.push({
          id: memberAgent.id,
          name: memberAgent.name,
          status: memberAgent.status,
        });
      }
    }
    await this.deps.deliveryEngine.deliverToMember(agentId, roomId, {
      type: "room_members",
      room: roomId,
      members,
    });

    // Notify existing members of the join
    await this.deps.deliveryEngine.deliverToRoom(
      roomId,
      {
        type: "member_joined",
        room: roomId,
        agent: agentId,
      },
      agentId,
    );

    return room;
  }

  /**
   * Leaves a room. For this store's own identity leaving a room it does not itself own, the local Room object is only ever this store's own static snapshot from when it joined or was invited (P3.6/P3.8) -- mutating it directly, as the legacy branch below does, would tell nobody but this store itself. The real effect needs a wire round trip to the room's own owner instead, so this always defers to leaveRemoteRoom in that case. Leaving on behalf of a DIFFERENT agentId, or the owner leaving their own room (this store's own authoritative copy), is untouched -- that is the legacy CRDT mutation state-sync-convergence.test.ts exercises directly.
   */
  async leaveRoom(roomIdOrName: string, agentId: string): Promise<void> {
    const roomId = resolveRoomId(this.deps.rooms, roomIdOrName);
    const room = this.deps.rooms.get(roomId);
    if (!room)
      throw new CommsError(`Room ${roomId} not found`, "ROOM_NOT_FOUND");
    const peerId = this.deps.getPeerId();
    if (agentId === peerId && room.owner !== peerId) {
      await this.leaveRemoteRoom(roomId, room.owner);
      return;
    }

    this.deps.deliveryEngine.bump(room);
    this.deps.deliveryEngine.recordMemberOp(room, "member", "leave", agentId);
    this.deps.deliveryEngine.refreshMembership(room);
    this.deps.rooms.set(roomId, room);

    const agent = this.deps.agents.get(agentId);
    if (agent) {
      agent.subscribedRooms = agent.subscribedRooms.filter(
        (id) => id !== roomId,
      );
      this.deps.agents.set(agentId, agent);
      await this.deps.deliveryEngine.broadcastPatch({
        type: "agent_upsert",
        agent,
      });
    }

    await this.deps.deliveryEngine.broadcastPatch({
      type: "room_upsert",
      room,
    });
    await this.deps.deliveryEngine.deliverToRoom(roomId, {
      type: "member_left",
      room: roomId,
      agent: agentId,
    });

    if (room.members.length === 0 && room.owner === agentId) {
      await this.destroyRoom(roomId, agentId);
    }
  }

  /**
   * The remote-leave path: roomPath names a room this store is a member of but does not own, so leaving for real means telling the owner over a real, wire-authenticated room.leave rather than mutating a local Room record nobody else reads. Also declineInvite's own mechanism (P3.8): the moment a target receives an invite (handleRoomInvite), it already holds a real, persisted room:member token exactly as if it had joined -- declining is simply leaving before ever really participating, and the owner's own receiving side (handleRoomLeave) tells the two cases apart by checking its own membership/invited lists, not by a separate verb. reason rides room.leave's own open extension tail so the owner can still surface a real decline reason without a second wire shape.
   */
  private async leaveRemoteRoom(
    roomPath: string,
    ownerId: string,
    reason?: string,
  ): Promise<void> {
    const { slot } = this.deps.requireIdentity();
    const token = loadRoomTokens(slot)[roomPath];
    if (token === undefined) {
      throw new CommsError(
        `No room:member token for ${roomPath}`,
        "NOT_MEMBER",
      );
    }
    const params: Record<string, unknown> = {
      verb: "room.leave",
      ...(reason !== undefined ? { reason } : {}),
    };
    const outcome = await this.deps
      .requireTransport()
      .sendRoomRequest(
        ownerId,
        { verb: ROOM_MEMBER_CAPABILITY, params },
        { kind: "room", path: roomPath },
        token,
      );
    if (outcome.result !== "ok") {
      throw new CommsError(
        `Leaving ${roomPath} failed (${outcome.code})`,
        "LEAVE_FAILED",
      );
    }
    deleteRoomToken(slot, roomPath);
    this.deps.rooms.delete(roomPath);
    this.deps.messages.delete(roomPath);
  }

  /**
   * Invites targetId to roomId, over a real, wire-authenticated room.invite (P3.8): mints a fresh room:member grant for the target, records its own token-id the same way admitRoomJoin does (kickFromRoom can revoke an invited member's own grant exactly as it can a joined one), and pushes the grant to the target directly in the invite request itself -- room.invite is deliberately ungated (the room's own owner needs no capability to invite, per core/room's design), so the target's own verification of the embedded token is what proves this invite is genuine, not anything about the connection it arrived on. Retains the local CRDT invited-list bookkeeping (still this store's own record of who it has invited) but no longer broadcasts it: the target learns of the invite from the real request, not a mesh-wide patch.
   */
  async inviteToRoom(
    roomIdOrName: string,
    targetId: string,
    inviterId: string,
  ): Promise<void> {
    const roomId = resolveRoomId(this.deps.rooms, roomIdOrName);
    const room = this.deps.rooms.get(roomId);
    if (!room)
      throw new CommsError(`Room ${roomId} not found`, "ROOM_NOT_FOUND");
    if (room.owner !== inviterId)
      throw new CommsError("Only the room owner can invite", "NOT_OWNER");

    this.deps.deliveryEngine.bump(room);
    if (!room.invited.includes(targetId) && !room.members.includes(targetId)) {
      this.deps.deliveryEngine.recordMemberOp(
        room,
        "invited",
        "join",
        targetId,
      );
    }
    this.deps.deliveryEngine.refreshMembership(room);
    this.deps.rooms.set(roomId, room);

    const { identity, clock, slot } = this.deps.requireIdentity();
    const tokenId = randomId();
    const verdict = await mintCapabilityToken({
      identity,
      clock,
      tokenId,
      bearer: deviceIdFromHex(targetId),
      capability: ROOM_MEMBER_CAPABILITY,
      scope: { kind: "room", path: roomId },
      expires: clock.now() + ROOM_TOKEN_LIFETIME_MS,
      delegationsRemaining: resolveDelegationsRemaining(
        ROOM_MEMBER_DELEGATION_POLICY,
        ROOM_MEMBER_CAPABILITY,
        targetId,
        0,
      ),
    });
    if (!verdict.ok) {
      throw new CommsError(
        `Failed to mint an invite grant for ${targetId}`,
        "MINT_FAILED",
      );
    }
    saveIssuedRoomGrant(slot, roomId, targetId, tokenId);

    const inviter = this.deps.agents.get(inviterId);
    const params: Record<string, unknown> = {
      verb: "room.invite",
      invitee: deviceIdFromHex(targetId),
      token: verdict.token,
      ...roomStateExtension(room),
      ...(inviter !== undefined ? inviterAgentExtension(inviter) : {}),
    };
    const outcome = await this.deps
      .requireTransport()
      .sendRoomRequest(
        targetId,
        { verb: ROOM_MEMBER_CAPABILITY, params },
        { kind: "room", path: roomId },
      );
    if (outcome.result !== "ok") {
      throw new CommsError(
        `Invite to ${targetId} for ${roomId} failed (${outcome.code})`,
        "INVITE_FAILED",
      );
    }
  }

  /**
   * Declines a pending invite, over the same real room.leave request leaveRemoteRoom already sends for an actual leave (P3.8): the moment this store received the invite (handleRoomInvite), it already holds a real, persisted room:member token, so declining before ever really participating is simply leaving early -- the owner's own receiving side (handleRoomLeave) tells the two cases apart from its own membership/invited lists, not from a separate verb. Uses parseRoomPath rather than any locally cached Room record to find the owner to leave, since handleRoomInvite never constructs one -- there is nothing here to read a room.owner field off in the first place.
   */
  async declineInvite(
    roomId: string,
    agentId: string,
    reason: string,
  ): Promise<void> {
    // Every real caller declines on its own behalf (tool.ts always passes ctx.agentId, which for a real bridge process is always this.peerId, per the design's own "one bridge is one agent is one device" organising fact) -- there is no remote-decline-on-someone-else's-behalf mechanism, so a mismatch here means the caller itself is confused about whose invite it is declining.
    if (agentId !== this.deps.getPeerId()) {
      throw new CommsError(
        `Cannot decline an invite on behalf of ${agentId}`,
        "NOT_SELF",
      );
    }
    const parsed = parseRoomPath(roomId);
    if (parsed.kind !== "owner-named") {
      throw new CommsError(`Room ${roomId} not found`, "ROOM_NOT_FOUND");
    }
    return this.leaveRemoteRoom(roomId, parsed.owner, reason);
  }

  /**
   * Revokes memberId's own room:member grant for roomId for real, if this identity ever recorded issuing one: mints a revocation-entry for its token-id, records it in this store's own RevocationView immediately, announces it to every connected peer, and forgets the issued-grant record (a later re-admission mints and records a genuinely fresh one rather than leaving a stale entry alongside it). Silently does nothing when no issued-grant record exists (a grant predating this bookkeeping, or a member who was never actually admitted a token at all) -- shared by kickFromRoom (owner-initiated) and RoomProtocol's own handleRoomLeave (member-initiated, including a decline), which calls this via a deferred closure since RoomProtocol is constructed before RoomLifecycle exists.
   */
  async revokeMemberGrant(roomId: string, memberId: string): Promise<void> {
    const { identity, clock, slot, revocation } = this.deps.requireIdentity();
    const tokenId = loadIssuedRoomGrant(slot, roomId, memberId);
    if (tokenId === undefined) return;
    const entry = await mintRevocationEntry({
      identity,
      tokenId,
      revokedAt: clock.now(),
    });
    await revocation.record(entry, { identity });
    await this.deps.requireTransport().broadcastRevocation([entry]);
    deleteIssuedRoomGrant(slot, roomId, memberId);
  }

  /**
   * Kicks targetId from roomId. Beyond the legacy CRDT membership removal (retired in P3.8 along with every other non-message broadcastPatch caller), this revokes the member's own room:member grant for real: mints a revocation-entry for the token-id this identity recorded when it admitted them (admitRoomJoin's own saveIssuedRoomGrant), records it in this store's own RevocationView immediately (so this identity's own future verifications see the kick without waiting on its own gossip), and announces it to every connected peer so each one's independent verification of the target's token -- not just this room's owner -- also starts failing as "revoked" from here on. Silently skips the revocation step (kick still happens; only the token-side enforcement doesn't) when no issued-grant record exists for this member, e.g. a grant predating this bookkeeping.
   */
  async kickFromRoom(
    roomIdOrName: string,
    targetId: string,
    kickerId: string,
  ): Promise<void> {
    const roomId = resolveRoomId(this.deps.rooms, roomIdOrName);
    const room = this.deps.rooms.get(roomId);
    if (!room)
      throw new CommsError(`Room ${roomId} not found`, "ROOM_NOT_FOUND");
    if (room.owner !== kickerId)
      throw new CommsError("Only the room owner can kick", "NOT_OWNER");

    await this.revokeMemberGrant(roomId, targetId);

    this.deps.deliveryEngine.bump(room);
    this.deps.deliveryEngine.recordMemberOp(room, "member", "leave", targetId);
    this.deps.deliveryEngine.recordMemberOp(room, "invited", "leave", targetId);
    this.deps.deliveryEngine.refreshMembership(room);
    this.deps.rooms.set(roomId, room);
    await this.deps.deliveryEngine.broadcastPatch({
      type: "room_upsert",
      room,
    });
  }

  /**
   * Destroys roomId, revoking every member's own room:member grant for real first (P3.8) -- the same revocation machinery kickFromRoom already uses, since destroying a room out from under its members is exactly as much a membership revocation as kicking them individually would be, just for all of them at once. Room-existence notification (agent_upsert/room_delete) stays on the legacy broadcastPatch for now: replacing it needs the same broader informational-events redesign the rest of P3.8 already tracks as separate, larger work, not something this specific fix should improvise alone.
   */
  async destroyRoom(roomIdOrName: string, agentId: string): Promise<void> {
    const roomId = resolveRoomId(this.deps.rooms, roomIdOrName);
    const room = this.deps.rooms.get(roomId);
    if (!room)
      throw new CommsError(`Room ${roomId} not found`, "ROOM_NOT_FOUND");
    if (room.owner !== agentId)
      throw new CommsError("Only the room owner can destroy", "NOT_OWNER");

    for (const memberId of room.members) {
      await this.revokeMemberGrant(roomId, memberId);
      const member = this.deps.agents.get(memberId);
      if (member) {
        member.subscribedRooms = member.subscribedRooms.filter(
          (id) => id !== roomId,
        );
        this.deps.agents.set(memberId, member);
        await this.deps.deliveryEngine.broadcastPatch({
          type: "agent_upsert",
          agent: member,
        });
      }
    }

    this.deps.rooms.delete(roomId);
    this.deps.messages.delete(roomId);
    await this.deps.deliveryEngine.broadcastPatch({
      type: "room_delete",
      roomId,
    });
  }

  /**
   * Admits bearerId into this user's own DM-communication scope (agent-comms#162): mints a fresh dm:send grant, self-signed by this store's own user principal (userIdentity, distinct from the per-bridge-slot device identity every other room:member grant above is minted against), with no parent -- a root-level admission, exactly like mintOwnerRootGrant's own room-owner self-grant. Records the token-id the same way admitRoomJoin/inviteToRoom record theirs (saveIssuedDmGrant), so revokeAgentDmAccess can later name which one to revoke. Returns the minted token for the caller to get to bearerId out of band (there is no wire-level push here, deliberately: this issue adds the receiver-side check and the admission primitive it checks against, not a new delivery mechanism for the grant itself).
   *
   * delegationsRemaining defaults to 0 -- the original, non-delegable behaviour, unchanged for a bearer that is just a bare device with no principal of its own. Passing a positive value admits bearerId as a user PRINCIPAL rather than a single device (agent-comms#187): the principal itself then holds enough delegation depth to mint further dm:send tokens (bearer = one of its own devices, parent = this grant) via dm-send-delegation.ts's delegateDmSendToDevice, the dm:send counterpart to how #161's device-membership tokens already let a principal admit its own devices. verifyDmSendToken needs no change to accept the result: its chain-walk already resolves rootIssuer through arbitrarily many hops back to this call's own userIdentity, regardless of how many of those hops this grant itself permits.
   */
  async admitAgentForDm(
    bearerId: string,
    delegationsRemaining = 0,
  ): Promise<CapabilityToken> {
    const { userIdentity, userIdentityOptions, clock } =
      this.deps.requireIdentity();
    const tokenId = randomId();
    const verdict = await mintCapabilityToken({
      identity: userIdentity,
      clock,
      tokenId,
      bearer: deviceIdFromHex(bearerId),
      capability: DM_SEND_CAPABILITY,
      scope: { kind: "user", path: deviceIdToHex(userIdentity.deviceId) },
      expires: clock.now() + DM_SEND_GRANT_LIFETIME_MS,
      delegationsRemaining,
    });
    if (!verdict.ok) {
      throw new CommsError(
        `Failed to mint a dm:send grant for ${bearerId}: ${verdict.reason}`,
        "MINT_FAILED",
      );
    }
    saveIssuedDmGrant(userIdentityOptions, bearerId, tokenId);
    return verdict.token;
  }

  /**
   * Revokes bearerId's own dm:send grant for real, if this user principal ever recorded issuing one: mints a revocation-entry for its token-id, records it in this store's own RevocationView immediately, announces it to every connected peer, and forgets the issued-grant record (a later re-admission mints and records a genuinely fresh one rather than leaving a stale entry alongside it) -- the same revocation shape revokeMemberGrant already gives room:member grants, applied to the user principal's own dm:send grants instead of a bridge-slot device identity's room grants. Silently does nothing when no issued-grant record exists (bearerId was never admitted, or the record predates this bookkeeping).
   */
  async revokeAgentDmAccess(bearerId: string): Promise<void> {
    const { userIdentity, userIdentityOptions, clock, revocation } =
      this.deps.requireIdentity();
    const tokenId = loadIssuedDmGrant(userIdentityOptions, bearerId);
    if (tokenId === undefined) return;
    const entry = await mintRevocationEntry({
      identity: userIdentity,
      tokenId,
      revokedAt: clock.now(),
    });
    await revocation.record(entry, { identity: userIdentity });
    await this.deps.requireTransport().broadcastRevocation([entry]);
    deleteIssuedDmGrant(userIdentityOptions, bearerId);
  }
}

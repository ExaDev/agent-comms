/**
 * DeliveryEngine — the busiest hub in MeshStore: owns queued/local delivery, room-membership CRDT merge (mergeRoom/refreshMembership/recordMemberOp), patch application and broadcast, read receipts, and the two gossip callbacks (presence-advert, revocation-announce) that mutate this state directly. Split out of mesh-store.ts to reduce it under the repo's max-lines cap. Every core Map it touches (agents/rooms/messages/dms/deliveryQueues/localDeliveryKeys/pendingMarkReadTimers) is a direct reference into MeshStore's own fields, shared by construction rather than copied, since AgentRegistry, RoomLifecycle, RoomProtocol, RoomMessaging, FederationBridge, and StaleAgentChecker all read or mutate the same underlying state.
 */

import type { CapabilityToken } from "wire-mesh-core/generated/protocol";
import type { RevocationEntry } from "wire-mesh-core/generated/protocol";
import { bytesFromHex } from "wire-mesh-core/domain/device-id";
import { loadRoomTokens } from "./identity-store.js";
import { dmRoomPath } from "./room-path.js";
import {
  MAX_QUEUED_DELIVERIES_PER_AGENT,
  mergeMessageHistories,
} from "./mesh-store-shared.js";
import type { MeshStoreIdentity } from "./mesh-store-shared.js";
import type { MeshTransport } from "./transport.js";
import type { RoomRequestOutcome } from "./send-outcome.js";
import type { MeshStatePatch, SerialisedState } from "./wire-protocol.js";
import type {
  AgentIdentity,
  AgentStatus,
  DeliveryEvent,
  DmMessage,
  MessageDelivery,
  Room,
  RoomMessage,
} from "./types.js";

/**
 * The state and collaborators DeliveryEngine needs from MeshStore. The Maps/Set/array are direct references into MeshStore's own fields (shared by construction, not copied); the closures read MeshStore's own current values or call through to a not-yet-constructed collaborator at the time DeliveryEngine itself is built (see sendRoomRequestToMember below).
 */
export interface DeliveryEngineDeps {
  agents: Map<string, AgentIdentity>;
  rooms: Map<string, Room>;
  messages: Map<string, RoomMessage[]>;
  dms: Map<string, DmMessage[]>;
  deliveryQueues: Map<string, DeliveryEvent[]>;
  localDeliveryKeys: Set<string>;
  pendingMarkReadTimers: ReturnType<typeof setTimeout>[];
  getPeerId: () => string;
  requireIdentity: () => MeshStoreIdentity;
  requireTransport: () => MeshTransport;
  getOnDelivery: () =>
    | ((agentId: string, event: DeliveryEvent) => void | Promise<void>)
    | undefined;
  getOnPatch: () =>
    ((patch: MeshStatePatch) => void | Promise<void>) | undefined;
  isShutDown: () => boolean;
  /**
   * Sends one directed room-domain request to a single member, reporting what became of it and queuing it for retry when the member never answered -- RoomProtocol's own method. Deferred: RoomProtocol doesn't exist yet when DeliveryEngine is constructed (construction order: discovery -\> deliveryEngine -\> ... -\> roomProtocol), so MeshStore wires this as `(...) => this.roomProtocol.sendRoomRequestToMember(...)`, a closure over `this` that only resolves `this.roomProtocol` when markRead actually calls it at runtime, well after the constructor has finished. Every call here carries a read receipt or an informational notice rather than a message of this device's own, so the outcome is deliberately not acted on: both are best-effort by design, and a recipient that refuses one has nothing a sender needs to be told about.
   */
  sendRoomRequestToMember: (
    memberId: string,
    roomPath: string,
    token: CapabilityToken,
    params: Record<string, unknown>,
  ) => Promise<RoomRequestOutcome>;
}

/** Cap on `localDeliveryKeys`, the dedup set of already-delivered event keys kept per process; oldest entries are evicted once this is exceeded. */
const MAX_LOCAL_DELIVERY_DEDUP_KEYS = 50;

export class DeliveryEngine {
  constructor(private readonly deps: DeliveryEngineDeps) {}

  // -----------------------------------------------------------------------
  // Gossip callbacks
  // -----------------------------------------------------------------------

  /** Applies a peer's gossiped presence status to this store's own local record, without broadcasting it back onto the mesh -- gossip itself is already how this fact propagates (each side's WireMeshTransport re-advertises its own status periodically), so re-broadcasting a received one would just bounce it around indefinitely. Silently ignored for a device-id this store doesn't yet have an agent record for: presence gossip is a transport-layer fact about an already-known peer's current status, not itself a source of truth for who that peer is -- that still comes only from agent_upsert/registerAgent, which carries the name/harness/cwd/tags a fabricated partial record here never could. */
  handlePresenceAdvert(agentId: string, status: AgentStatus): void {
    const agent = this.deps.agents.get(agentId);
    if (agent === undefined || agent.status === status) return;
    agent.status = status;
    this.bump(agent);
    void this.notifyRoomsOfStatus(agentId, status);
  }

  /** Verifies a gossiped revocation-entry and, if it verifies, records it in this store's own RevocationView -- future verifyRoomToken calls against this token's (token-id, issuer) pair fail with "revoked" from this point on. A failing entry is dropped silently: the same "hostile input produces a verdict, never a throw" contract verifyRevocationEntry itself already guarantees, so there is nothing further for a caller to react to. */
  async handleRevocationAnnounce(entry: RevocationEntry): Promise<void> {
    const { identity, revocation } = this.deps.requireIdentity();
    await revocation.record(entry, { identity });
  }

  // -----------------------------------------------------------------------
  // Queueing and membership merge
  // -----------------------------------------------------------------------

  /** Append to a target agent's delivery queue, bounded oldest-first (#28). */
  queueDelivery(agentId: string, event: DeliveryEvent): void {
    const arr = this.deps.deliveryQueues.get(agentId) ?? [];
    arr.push(event);
    if (arr.length > MAX_QUEUED_DELIVERIES_PER_AGENT) {
      arr.splice(0, arr.length - MAX_QUEUED_DELIVERIES_PER_AGENT);
    }
    this.deps.deliveryQueues.set(agentId, arr);
  }

  /**
   * Merge an incoming room record into the local one. Scalar fields follow the version gate the caller already applied (an equal or higher version reaches here), while membership is always element-merged per agent by highest operation revision, so concurrent joins of different agents survive and a kick racing a join converges with the kick honoured (#27). The members and invited views are re-derived from the merged operations.
   */
  private mergeRoom(incoming: Room): void {
    const existing = this.deps.rooms.get(incoming.id);
    if (existing === undefined) {
      this.refreshMembership(incoming);
      this.deps.rooms.set(incoming.id, incoming);
      return;
    }
    existing.version = Math.max(existing.version, incoming.version);
    existing.name = incoming.name;
    existing.type = incoming.type;
    existing.owner = incoming.owner;
    existing.createdAt = incoming.createdAt;
    existing.description = incoming.description;
    existing.memberJoins = DeliveryEngine.mergeMemberOps(
      existing.memberJoins,
      incoming.memberJoins,
    );
    existing.memberLeaves = DeliveryEngine.mergeMemberOps(
      existing.memberLeaves,
      incoming.memberLeaves,
    );
    existing.invitedJoins = DeliveryEngine.mergeMemberOps(
      existing.invitedJoins,
      incoming.invitedJoins,
    );
    existing.invitedLeaves = DeliveryEngine.mergeMemberOps(
      existing.invitedLeaves,
      incoming.invitedLeaves,
    );
    this.refreshMembership(existing);
  }

  /**
   * Derive the members and invited views from the per-agent operation maps. An agent is in the list when their latest join strictly outranks their latest leave; equal revisions mean the leave wins, so a kick racing a concurrent join converges with the kick honoured (#27).
   */
  refreshMembership(room: Room): void {
    room.members = Object.keys(room.memberJoins).filter(
      (id) => (room.memberJoins[id] ?? 0) > (room.memberLeaves[id] ?? 0),
    );
    room.invited = Object.keys(room.invitedJoins).filter(
      (id) => (room.invitedJoins[id] ?? 0) > (room.invitedLeaves[id] ?? 0),
    );
  }

  /** Record a membership operation at the room's current revision. */
  recordMemberOp(
    room: Room,
    list: "member" | "invited",
    op: "join" | "leave",
    agentId: string,
  ): void {
    const joins = list === "member" ? room.memberJoins : room.invitedJoins;
    const leaves = list === "member" ? room.memberLeaves : room.invitedLeaves;
    const stamp = room.version;
    if (op === "join") joins[agentId] = stamp;
    else leaves[agentId] = stamp;
  }

  /** Merge per-agent operation maps by highest revision per agent. */
  private static mergeMemberOps(
    local: Readonly<Record<string, number>>,
    incoming: Readonly<Record<string, number>>,
  ): Record<string, number> {
    const merged: Record<string, number> = { ...local };
    for (const [id, stamp] of Object.entries(incoming)) {
      if (stamp > (merged[id] ?? 0)) merged[id] = stamp;
    }
    return merged;
  }

  /** Bump an entity's sync revision; call before broadcasting a local mutation. */
  bump<T extends { version: number }>(entity: T): T {
    entity.version += 1;
    return entity;
  }

  // -----------------------------------------------------------------------
  // State sync and patch application
  // -----------------------------------------------------------------------

  /**
   * Merge a peer's state snapshot into the local state. Agents and rooms accept the incoming copy when it carries a revision at least as high as the local one, so a peer holding stale entities converges when it receives a fresher snapshot, while its own stale copies are rejected by peers that stayed current (#27). Message and DM histories are append-only: add unseen entries and union read receipts.
   */
  applyStateSync(state: SerialisedState): void {
    const incoming = {
      agents: new Map(Object.entries(state.agents)),
      rooms: new Map(Object.entries(state.rooms)),
      messages: new Map(Object.entries(state.messages)),
      dms: new Map(Object.entries(state.dms)),
    };
    for (const [id, agent] of incoming.agents) {
      const existingVersion = this.deps.agents.get(id)?.version;
      if (existingVersion !== undefined && agent.version < existingVersion) {
        continue;
      }
      if (existingVersion === agent.version) {
        const existing = this.deps.agents.get(id);
        if (existing) {
          for (const r of existing.subscribedRooms) {
            if (!agent.subscribedRooms.includes(r))
              agent.subscribedRooms.push(r);
          }
        }
      }
      this.deps.agents.set(id, agent);
    }
    for (const [id, room] of incoming.rooms) {
      const existingVersion = this.deps.rooms.get(id)?.version;
      if (existingVersion !== undefined && room.version < existingVersion) {
        continue;
      }
      this.mergeRoom(room);
    }
    for (const [id, msgs] of incoming.messages) {
      const existing = this.deps.messages.get(id);
      if (existing === undefined) {
        this.deps.messages.set(id, msgs);
        continue;
      }
      this.deps.messages.set(id, mergeMessageHistories(existing, msgs));
    }
    for (const [id, dmMsgs] of incoming.dms) {
      const existing = this.deps.dms.get(id);
      if (existing === undefined) {
        this.deps.dms.set(id, dmMsgs);
        continue;
      }
      this.deps.dms.set(id, mergeMessageHistories(existing, dmMsgs));
    }
    for (const [agentId, events] of Object.entries(state.deliveryQueues)) {
      const seen = new Set(
        (this.deps.deliveryQueues.get(agentId) ?? []).map((e) =>
          JSON.stringify(e),
        ),
      );
      for (const event of events) {
        if (seen.has(JSON.stringify(event))) continue;
        this.queueDelivery(agentId, event);
        // Replay fires only for events with consumption evidence (#28): messages are consumed by reading (readBy), invites by acceptance or decline (no longer in the invited list). Transient notifications (member_joined, room_members, connection_request, delivery status) carry no consumption evidence, so replaying them could only ever duplicate-notify; the state they describe arrives via the synced room and agent records instead. They still merge into the queue, so drain bridges see them.
        if (event.type === "room_message" || event.type === "dm") {
          this.fireLocalDelivery(agentId, event);
        } else if (event.type === "room_invite") {
          const stillInvited = this.deps.rooms
            .get(event.room)
            ?.invited.includes(agentId);
          if (stillInvited === true) {
            this.fireLocalDelivery(agentId, event);
          }
        }
      }
    }
  }

  async applyPatch(patch: MeshStatePatch): Promise<void> {
    switch (patch.type) {
      case "agent_upsert": {
        const existingAgent = this.deps.agents.get(patch.agent.id);
        if (
          existingAgent !== undefined &&
          patch.agent.version < existingAgent.version
        ) {
          // Stale copy from a peer that missed updates (#27).
          break;
        }
        const merged = patch.agent;
        if (existingAgent?.version === patch.agent.version) {
          // Concurrent mutations from the same base: keep subscriptions gained locally. A strictly higher version replaces the record.
          for (const r of existingAgent.subscribedRooms) {
            if (!merged.subscribedRooms.includes(r))
              merged.subscribedRooms.push(r);
          }
        }
        this.deps.agents.set(merged.id, merged);
        break;
      }
      case "agent_offline": {
        const agent = this.deps.agents.get(patch.agentId);
        if (agent === undefined) break;
        // An agent is its own store's peer, so this store is the authority on whether it is running. A report that it is offline while it is (a previous coordinator retiring the session it fronted, or a stale process probe) is stale by definition, and applying it would stick: this store gossips its own status, so it would go on advertising itself offline. It is contradicted instead, at a higher revision so every peer accepts the correction. A store that has itself set its agent offline is not contradicted.
        if (
          patch.agentId === this.deps.getPeerId() &&
          agent.status !== "offline"
        ) {
          this.bump(agent);
          await this.broadcastPatch({ type: "agent_upsert", agent });
          break;
        }
        agent.status = "offline";
        this.deps.agents.set(patch.agentId, agent);
        break;
      }
      case "room_upsert": {
        const existing = this.deps.rooms.get(patch.room.id);
        if (existing !== undefined && patch.room.version < existing.version) {
          // Stale copy from a peer that missed updates (#27).
          break;
        }
        this.mergeRoom(patch.room);
        break;
      }
      case "room_delete":
        this.deps.rooms.delete(patch.roomId);
        break;
      case "message_add": {
        const arr = this.deps.messages.get(patch.roomId) ?? [];
        arr.push(patch.message);
        this.deps.messages.set(patch.roomId, arr);
        break;
      }
      case "dm_add": {
        const arr = this.deps.dms.get(patch.key) ?? [];
        arr.push(patch.message);
        this.deps.dms.set(patch.key, arr);
        break;
      }
      case "delivery": {
        this.queueDelivery(patch.agentId, patch.event);
        const onDelivery = this.deps.getOnDelivery();
        if (patch.agentId === this.deps.getPeerId() && onDelivery) {
          // Deduplicate against local deliveries
          const eventKey = JSON.stringify(patch.event);
          if (this.deps.localDeliveryKeys.has(eventKey)) break;
          this.deps.localDeliveryKeys.add(eventKey);
          if (
            this.deps.localDeliveryKeys.size > MAX_LOCAL_DELIVERY_DEDUP_KEYS
          ) {
            const oldest = this.deps.localDeliveryKeys.values().next().value;
            if (oldest !== undefined)
              this.deps.localDeliveryKeys.delete(oldest);
          }
          void onDelivery(patch.agentId, patch.event);
          // Auto-mark read — scheduled as a macrotask to yield to the event loop. Without this yield, the delivery → markRead → broadcast → peer receives → handleDataMessage chain monopolises the microtask queue and starves macrotasks (timers, new connections, sendRoomMessage return values).
          const evt = patch.event;
          const timer = setTimeout(() => {
            if (this.deps.isShutDown()) return;
            if (evt.type === "room_message") {
              void this.markRead(
                evt.message.id,
                this.deps.getPeerId(),
                evt.message.room,
              );
            } else if (evt.type === "dm") {
              void this.markRead(evt.message.id, this.deps.getPeerId());
            }
          }, 0);
          if (!this.deps.isShutDown())
            this.deps.pendingMarkReadTimers.push(timer);
        }
        break;
      }
    }

    const onPatch = this.deps.getOnPatch();
    if (onPatch) {
      await onPatch(patch);
    }
  }

  // -----------------------------------------------------------------------
  // Broadcast and local delivery
  // -----------------------------------------------------------------------

  async broadcastPatch(patch: MeshStatePatch): Promise<void> {
    await this.deps
      .requireTransport()
      .broadcast({ method: "state_update", patch });
    const onPatch = this.deps.getOnPatch();
    if (onPatch) {
      await onPatch(patch);
    }
  }

  async deliverLocallyAndBroadcast(
    agentId: string,
    event: DeliveryEvent,
  ): Promise<void> {
    // Local delivery
    this.queueDelivery(agentId, event);

    // Auto-emit delivered status for messages
    if (event.type === "room_message") {
      await this.emitDeliveryStatus(
        event.message.id,
        agentId,
        { status: "delivered" },
        event.message.room,
      );
    } else if (event.type === "dm") {
      await this.emitDeliveryStatus(event.message.id, agentId, {
        status: "delivered",
      });
    }

    this.fireLocalDelivery(agentId, event);

    // Remote delivery
    const patch: MeshStatePatch = { type: "delivery", agentId, event };
    await this.broadcastPatch(patch);
  }

  /**
   * Fire onDelivery for an event targeting this peer's own agent, deduped against events already delivered in this process. Used both for live deliveries and for replays of events that accumulated while this process was down (#28): the dedup set is per-process, so a replayed event this process never saw fires, and one it already handled does not.
   */
  fireLocalDelivery(agentId: string, event: DeliveryEvent): void {
    const onDelivery = this.deps.getOnDelivery();
    if (agentId !== this.deps.getPeerId() || !onDelivery) return;
    // A room message or DM this agent has already read was already pushed and consumed: read receipts mutate the event between snapshots, so a plain structural key would miss and re-fire on the next sync (#28).
    if (
      (event.type === "room_message" || event.type === "dm") &&
      event.message.readBy.includes(agentId)
    ) {
      return;
    }
    const eventKey = JSON.stringify(event);
    if (this.deps.localDeliveryKeys.has(eventKey)) return;
    this.deps.localDeliveryKeys.add(eventKey);
    // Prevent unbounded growth — evict oldest when cap reached
    if (this.deps.localDeliveryKeys.size > MAX_LOCAL_DELIVERY_DEDUP_KEYS) {
      const oldest = this.deps.localDeliveryKeys.values().next().value;
      if (oldest !== undefined) this.deps.localDeliveryKeys.delete(oldest);
    }
    void onDelivery(agentId, event);
    // Delivered to this process, so no longer pending for it. Peers that never fired the event keep their copies, which is what a restart replays from (#28). Key-based match: replayed events are JSON clones.
    const queued = this.deps.deliveryQueues.get(agentId);
    if (queued !== undefined) {
      const idx = queued.findIndex((e) => JSON.stringify(e) === eventKey);
      if (idx !== -1) queued.splice(idx, 1);
    }
    // Auto-mark read — scheduled as a macrotask to yield to the event loop.
    const timer = setTimeout(() => {
      if (this.deps.isShutDown()) return;
      if (event.type === "room_message") {
        void this.markRead(event.message.id, agentId, event.message.room);
      } else if (event.type === "dm") {
        void this.markRead(event.message.id, agentId);
      }
    }, 0);
    if (!this.deps.isShutDown()) this.deps.pendingMarkReadTimers.push(timer);
  }

  /**
   * Delivers a single informational event to one specific agent over a given room-path: queues it locally (matching every other queueDelivery caller's own "hold it for whoever reads it next" contract), then either fires local delivery directly for this store's own agent or sends a real, wire-authenticated room.notify -- replacing the legacy mesh-wide broadcastPatch every one of this method's callers used to ride via deliverLocallyAndBroadcast, per P3.8's own directed-delivery retirement (agent-comms#48). Silently does nothing beyond the local queue when this store holds no current room:member token for roomPath, the same best-effort-by-design choice markRead's own directed room.read already makes for an unreachable read receipt. Public: used both internally (deliverToRoom, notifyRoomsOfNameChange, emitDeliveryStatus) and by other collaborators (RoomLifecycle's own post-join member-list delivery) that already know the exact single member and room-path to address.
   */
  async deliverToMember(
    memberId: string,
    roomPath: string,
    event: DeliveryEvent,
  ): Promise<void> {
    this.queueDelivery(memberId, event);
    if (memberId === this.deps.getPeerId()) {
      this.fireLocalDelivery(memberId, event);
      return;
    }
    const { slot } = this.deps.requireIdentity();
    const token = loadRoomTokens(slot)[roomPath];
    if (token === undefined) return;
    await this.deps.sendRoomRequestToMember(memberId, roomPath, token, {
      verb: "room.notify",
      event,
    });
  }

  /**
   * Delivers an informational event (member_status, member_joined, name_changed, and the like -- never room_message/dm, which already ride handleRoomSend's own directed path) to every current member of a room, via deliverToMember for each.
   */
  async deliverToRoom(
    roomId: string,
    event: DeliveryEvent,
    excludeAgent?: string,
  ): Promise<void> {
    const room = this.deps.rooms.get(roomId);
    if (!room) return;
    for (const memberId of room.members) {
      if (memberId === excludeAgent) continue;
      await this.deliverToMember(memberId, roomId, event);
    }
  }

  async notifyRoomsOfStatus(
    agentId: string,
    status: AgentStatus,
  ): Promise<void> {
    const agent = this.deps.agents.get(agentId);
    if (!agent) return;
    for (const roomId of agent.subscribedRooms) {
      await this.deliverToRoom(roomId, {
        type: "member_status",
        room: roomId,
        agent: agentId,
        status,
      });
    }
  }

  async notifyRoomsOfNameChange(
    agentId: string,
    oldName: string,
    newName: string,
  ): Promise<void> {
    const agent = this.deps.agents.get(agentId);
    if (!agent) return;
    const event: DeliveryEvent = {
      type: "name_changed",
      agent: agentId,
      oldName,
      newName,
    };
    for (const roomId of agent.subscribedRooms) {
      await this.deliverToRoom(roomId, event, agentId);
    }
    // Also deliver to the agent itself so it sees confirmation -- addressed via the implicit DM path when the renamed agent is a remote peer (e.g. renamed through the web console's own directory, which places no local-only restriction on which agent it targets), since a name change has no room context of its own to ride.
    const peerId = this.deps.getPeerId();
    if (agentId === peerId) {
      this.queueDelivery(agentId, event);
      this.fireLocalDelivery(agentId, event);
      return;
    }
    await this.deliverToMember(agentId, dmRoomPath(peerId, agentId), event);
  }

  private async emitDeliveryStatus(
    messageId: string,
    agentId: string,
    delivery: MessageDelivery,
    room?: string,
  ): Promise<void> {
    const location = this.findMessageLocation(messageId, room);
    if (location === undefined) return;
    const { roomPath, from: senderId } = location;
    const event: DeliveryEvent = {
      type: "delivery_status",
      messageId,
      agent: agentId,
      delivery,
      room,
    };
    if (senderId === this.deps.getPeerId()) {
      this.queueDelivery(senderId, event);
      this.fireLocalDelivery(senderId, event);
      return;
    }
    await this.deliverToMember(senderId, roomPath, event);
  }

  /** Returns the room-path a directed room.notify/room.read needs to address for a given message: room itself for a room message, or the specific DM key (this.dms is keyed by dmRoomPath/"self:...", not the bare pair) the message was actually found under. */
  private findMessageLocation(
    messageId: string,
    room?: string,
  ): { roomPath: string; from: string } | undefined {
    if (room !== undefined) {
      const msg = this.deps.messages.get(room)?.find((m) => m.id === messageId);
      return msg === undefined ? undefined : { roomPath: room, from: msg.from };
    }
    for (const [key, msgs] of this.deps.dms) {
      const msg = msgs.find((m) => m.id === messageId);
      if (msg) return { roomPath: key, from: msg.from };
    }
    return undefined;
  }

  /**
   * Marks a message read by readBy (always this store's own identity -- see the auto-mark-read timers in fireLocalDelivery and drainDelivery, its only callers) and notifies the message's own author via a directed, wire-authenticated room.read (P3.5), replacing the legacy message_read patch's mesh-wide broadcast: only the author is a genuine audience for "did you read my message" per core/room's own always-voluntary read-receipt design, and a direct request to them is strictly more than the old broadcast actually needed. Silently does nothing beyond the local readBy update when the author is this store itself (a self-DM, or an already-own message) or when this store holds no room:member token for the message's own room-path -- read receipts stay best-effort by design, never a reason to throw.
   */
  private async markRead(
    messageId: string,
    readBy: string,
    room?: string,
  ): Promise<void> {
    const location = this.findMessageLocation(messageId, room);
    if (location === undefined) return;
    const { roomPath, from } = location;

    const history =
      room !== undefined
        ? this.deps.messages.get(room)
        : this.deps.dms.get(roomPath);
    const message = history?.find((m) => m.id === messageId);
    if (message && !message.readBy.includes(readBy)) {
      message.readBy.push(readBy);
    }

    if (from === readBy) return;

    const { slot, clock } = this.deps.requireIdentity();
    const token = loadRoomTokens(slot)[roomPath];
    if (token === undefined) return;

    const params: Record<string, unknown> = {
      verb: "room.read",
      messages: [bytesFromHex(messageId)],
      at: clock.now(),
    };
    await this.deps.sendRoomRequestToMember(from, roomPath, token, params);
  }

  // -----------------------------------------------------------------------
  // CommsStore — Delivery
  // -----------------------------------------------------------------------

  async deliver(agentId: string, event: DeliveryEvent): Promise<void> {
    await this.deliverLocallyAndBroadcast(agentId, event);
  }

  async drainDelivery(agentId: string): Promise<DeliveryEvent[]> {
    await Promise.resolve();
    const events = this.deps.deliveryQueues.get(agentId) ?? [];
    this.deps.deliveryQueues.set(agentId, []);

    // Auto-mark messages as read — drain bridges consume on tool call
    for (const event of events) {
      if (event.type === "room_message") {
        await this.markRead(event.message.id, agentId, event.message.room);
      } else if (event.type === "dm") {
        await this.markRead(event.message.id, agentId);
      }
    }

    return events;
  }
}

/**
 * RoomProtocol — the receiving/responding half of the room wire protocol: the room-verb handlers a WireMeshTransport dispatches into (room.send, room.read, room.members, room.join, room.invite, room.leave), the directed room-domain request fan-out primitives (sendRoomMessageDirected, sendRoomRequestToMember, its retry queue and flush), and the human accept/reject decision points for a pending room.join. Split out of mesh-store.ts to reduce it under the repo's max-lines cap. Owns pendingRoomRequests and pendingRoomJoins exclusively -- nothing outside this class ever reads or writes them.
 */

import { bytesToHex, deviceIdFromHex } from "wire-mesh-core/domain/device-id";
import { mintCapabilityToken } from "wire-mesh-core/domain/tokens";
import type {
  IncomingManageRequest,
  ManageOutcome,
} from "wire-mesh-core/domain/mesh-session";
import {
  roomInviteSchema,
  roomLeaveSchema,
  roomReadSchema,
  roomSendSchema,
} from "wire-mesh-core/generated/protocol";
import type {
  CapabilityToken,
  MessageRef,
} from "wire-mesh-core/generated/protocol";
import { parseRoomPath } from "./room-path.js";
import {
  ROOM_MEMBER_CAPABILITY,
  ROOM_MEMBER_DELEGATION_POLICY,
  verifyRoomToken,
} from "./room-token-verification.js";
import { resolveDelegationsRemaining } from "./delegation-policy.js";
import { verifyDmSendToken } from "./dm-token-verification.js";
import {
  loadRoomTokens,
  saveIssuedRoomGrant,
  saveRoomToken,
} from "./identity-store.js";
import { randomId } from "./random-id.js";
import { CommsError } from "./store.js";
import {
  MAX_PENDING_ROOM_REQUESTS_PER_MEMBER,
  PENDING_ROOM_REQUEST_TTL_MS,
  ROOM_TOKEN_LIFETIME_MS,
} from "./mesh-store-shared.js";
import {
  classifyManageOutcome,
  type RoomRequestOutcome,
} from "./send-outcome.js";
import type {
  MeshStoreIdentity,
  RoomJoinDecision,
} from "./mesh-store-shared.js";
import {
  parseInviterAgentExtension,
  parseRoomStateExtension,
  roomStateExtension,
} from "./room-wire-extensions.js";
import type { DeliveryEngine } from "./delivery-engine.js";
import type { RoomVerbHandler } from "./room-router.js";
import type { ConnectionHandle, MeshTransport } from "./transport.js";
import { z } from "zod";
import { DeliveryEventSchema, StreamingBehavior } from "./types.js";
import type {
  AgentIdentity,
  DeliveryEvent,
  DmMessage,
  MessageDelivery,
  Room,
  RoomMessage,
  TransientSendFailure,
} from "./types.js";

/** One directed room-domain request held for retry. queuedAt fixes the entry's age for the queue's own age bound, and survives a failed retry rather than being refreshed by it, so a member that is briefly reachable over and over cannot keep a message pending forever. messageId is the hex id of the message this request carries, present only for a room.send: a room.read or room.notify has no message of this sender's own to report a status against. */
interface PendingRoomRequest {
  roomPath: string;
  params: Record<string, unknown>;
  queuedAt: number;
  reason: TransientSendFailure;
  messageId: string | undefined;
}

/** The hex message-id a directed room-domain request carries, when it is a room.send carrying one. Read from the already-built params rather than re-derived, so a queued entry can report a delivery status against the very message the sender was told about. */
function messageIdFromParams(
  params: Readonly<Record<string, unknown>>,
): string | undefined {
  if (params.verb !== "room.send") return undefined;
  const raw = params["message-id"];
  return raw instanceof Uint8Array ? bytesToHex(raw) : undefined;
}

/** room.notify's own params shape: the already-validated DeliveryEvent to deliver, and nothing else -- room.notify carries no content of its own beyond the event, unlike room.send's own message/dm fields. Not a wire-mesh-generated schema (room.notify is agent-comms' own verb, riding manage-command-params' open socket the same way the legacy opaque frame carriage always did, never a real wire-mesh CDDL type other clients need to interoperate with). */
const RoomNotifyParamsSchema = z.object({ event: DeliveryEventSchema });

/** The state and collaborators RoomProtocol needs from MeshStore. rooms/messages/dms/agents/dmRequestsInitiatedByMe are direct references into MeshStore's own fields; deliveryEngine is the already-constructed instance, narrowed to what a room-verb handler ever needs; revokeMemberGrant is deferred (RoomLifecycle, which owns it, doesn't exist yet when RoomProtocol is constructed -- construction order: ... -\> roomProtocol -\> roomMessaging -\> roomLifecycle -\> ...), wired the same lazy-`this`-capture way DeliveryEngine's own sendRoomRequestToMember closure is. */
export interface RoomProtocolDeps {
  rooms: Map<string, Room>;
  messages: Map<string, RoomMessage[]>;
  dms: Map<string, DmMessage[]>;
  agents: Map<string, AgentIdentity>;
  dmRequestsInitiatedByMe: Set<string>;
  getPeerId: () => string;
  requireIdentity: () => MeshStoreIdentity;
  requireTransport: () => MeshTransport;
  deliveryEngine: Pick<
    DeliveryEngine,
    | "queueDelivery"
    | "fireLocalDelivery"
    | "bump"
    | "recordMemberOp"
    | "refreshMembership"
    | "broadcastPatch"
    | "deliverToRoom"
  >;
  /** How long a room.join may await a human decision before this side expires it and answers the requester with a timeout. */
  joinDecisionTimeoutMs: number;
  /** RoomLifecycle's own method, deferred -- see the interface doc comment above. */
  revokeMemberGrant: (roomId: string, memberId: string) => Promise<void>;
}

export class RoomProtocol {
  /** Directed room-domain requests (room.send, room.read) that failed because their target member wasn't reachable at send time, held for retry when that member becomes reachable by any route -- the wire-authenticated fan-out's substitute for the legacy full-state-sync's own automatic eventual consistency, since a direct request to a disconnected peer fails immediately with no protocol-level retry of its own. Keyed by member device-id hex, bounded oldest-first per member and by each entry's own age; every entry that leaves the queue without being delivered is reported to its sender as a terminal delivery status. */
  private readonly pendingRoomRequests = new Map<
    string,
    PendingRoomRequest[]
  >();

  /** Pending room.join requests awaiting owner approval, keyed by `${roomPath}::${requesterId}` -- the held-open manage-request's own resolve() function is stored here so acceptRoomJoin/rejectRoomJoin can settle it in place. */
  private readonly pendingRoomJoins = new Map<
    string,
    {
      roomPath: string;
      requesterId: string;
      resolve: (decision: RoomJoinDecision) => void;
    }
  >();

  constructor(private readonly deps: RoomProtocolDeps) {}

  /** Room verb handlers this store registers with its own WireMeshTransport, keyed by params.verb per room-router.ts's own dispatch discipline. */
  get roomVerbHandlers(): Partial<Record<string, RoomVerbHandler>> {
    return {
      "room.join": async (request, handle) =>
        this.handleRoomJoin(request, handle),
      "room.send": async (request, handle) =>
        this.handleRoomSend(request, handle),
      "room.read": async (request, handle) =>
        this.handleRoomRead(request, handle),
      "room.members": async (request, handle) =>
        this.handleRoomMembers(request, handle),
      "room.invite": async (request) => this.handleRoomInvite(request),
      "room.leave": async (request, handle) =>
        this.handleRoomLeave(request, handle),
      "room.notify": async (request, handle) =>
        this.handleRoomNotify(request, handle),
    };
  }

  /** Reads the "reply" message-ref out of a room.send's own params (if any) and returns the hex id it names -- room.send's replyTo carries a single parent message, so the first reply-relation ref is the one that matters; any further refs are a future relation this handler doesn't yet act on. */
  private static replyToFromRefs(
    refs: readonly MessageRef[] | undefined,
  ): string | undefined {
    const reply = refs?.find((ref) => ref.relation === "reply");
    return reply === undefined ? undefined : bytesToHex(reply.id);
  }

  /** Reads room.send's own "streaming-behavior" extension field (open params tail, not a named schema field) and validates it against the same StreamingBehavior contract every other delivery path already enforces -- an unrecognised or malformed value is dropped rather than rejecting the whole send, matching core/room's own obligation to ignore what it doesn't understand instead of failing closed on an extension field. */
  private static streamingBehaviorFromParams(
    params: Readonly<Record<string, unknown>>,
  ): StreamingBehavior | undefined {
    const raw = params["streaming-behavior"];
    if (raw === undefined) return undefined;
    const result = StreamingBehavior.safeParse(raw);
    return result.success ? result.data : undefined;
  }

  /**
   * Receiving side of a directed room.send (P3.5): verifies the presented token against all six of core/room's own obligations, then delivers the message locally exactly once -- the manage-response this returns IS the delivery receipt, so there is no separate "delivered" event to emit the way the legacy broadcastPatch path needed one. Branches on the room-path's own shape: an owner-named path stores a RoomMessage in this room's own history and fires a room_message event; a DM path stores a DmMessage keyed by the same dm-path sendDm already uses and fires a dm event -- both ride the identical room:member-gated verb, since a DM is just a room-path variant, not a separate verb.
   */
  private async handleRoomSend(
    request: IncomingManageRequest,
    handle: Readonly<ConnectionHandle>,
  ): Promise<ManageOutcome> {
    const roomPath = request.scope.path;
    if (roomPath === undefined) {
      return { result: "error", code: "missing_scope_path" };
    }
    if (request.token === undefined) {
      return { result: "error", code: "unauthorized" };
    }
    const { identity, clock, revocation } = this.deps.requireIdentity();
    const verdict = await verifyRoomToken(request.token, {
      identity,
      clock,
      revocation,
      expectedBearer: deviceIdFromHex(handle.id),
      roomPath,
    });
    if (!verdict.ok) {
      return { result: "error", code: "unauthorized" };
    }

    const parsedParams = roomSendSchema.safeParse(request.command.params);
    if (!parsedParams.success) {
      return { result: "error", code: "malformed_params" };
    }
    const params = parsedParams.data;
    const replyTo = RoomProtocol.replyToFromRefs(params.refs);
    const streamingBehavior = RoomProtocol.streamingBehaviorFromParams(params);
    const id = bytesToHex(params["message-id"]);
    const timestamp = new Date(params["sent-at"]).toISOString();
    const peerId = this.deps.getPeerId();

    const parsedPath = parseRoomPath(roomPath);
    let event: DeliveryEvent;
    if (parsedPath.kind === "dm") {
      const message: DmMessage = {
        id,
        from: handle.id,
        to: peerId,
        content: params.text,
        timestamp,
        readBy: [handle.id],
        ...(streamingBehavior !== undefined && { streamingBehavior }),
      };
      const history = this.deps.dms.get(roomPath) ?? [];
      history.push(message);
      this.deps.dms.set(roomPath, history);
      event = { type: "dm", message };
    } else {
      const message: RoomMessage = {
        id,
        from: handle.id,
        room: roomPath,
        content: params.text,
        timestamp,
        readBy: [handle.id],
        ...(replyTo !== undefined && { replyTo }),
        ...(streamingBehavior !== undefined && { streamingBehavior }),
      };
      const history = this.deps.messages.get(roomPath) ?? [];
      history.push(message);
      this.deps.messages.set(roomPath, history);
      event = { type: "room_message", message };
    }

    this.deps.deliveryEngine.queueDelivery(peerId, event);
    this.deps.deliveryEngine.fireLocalDelivery(peerId, event);

    return { result: "ok" };
  }

  /**
   * Receiving side of a directed room.notify (P3.8): the same token verification handleRoomSend does, then queues and fires the already-validated DeliveryEvent locally exactly as if it had arrived any other way -- room.notify carries no content of its own beyond the event, so there is nothing to construct or persist here, unlike room.send's own message/dm branches. Replaces the legacy mesh-wide broadcastPatch deliverToRoom used to ride for informational events (member_status, member_joined, name_changed, and the like) with a real directed request to each room member, matching room.send/room.read's own established shape. A malformed event, or one whose own room field doesn't match the token's verified scope, is refused rather than silently accepted -- unlike a gossiped advert's own self-asserted facts, this is an authenticated peer actively claiming something happened, so it gets the same strict validation room.send's params already get.
   */
  private async handleRoomNotify(
    request: IncomingManageRequest,
    handle: Readonly<ConnectionHandle>,
  ): Promise<ManageOutcome> {
    const roomPath = request.scope.path;
    if (roomPath === undefined) {
      return { result: "error", code: "missing_scope_path" };
    }
    if (request.token === undefined) {
      return { result: "error", code: "unauthorized" };
    }
    const { identity, clock, revocation } = this.deps.requireIdentity();
    const verdict = await verifyRoomToken(request.token, {
      identity,
      clock,
      revocation,
      expectedBearer: deviceIdFromHex(handle.id),
      roomPath,
    });
    if (!verdict.ok) {
      return { result: "error", code: "unauthorized" };
    }

    const parsedParams = RoomNotifyParamsSchema.safeParse(
      request.command.params,
    );
    if (!parsedParams.success) {
      return { result: "error", code: "malformed_params" };
    }
    const event = parsedParams.data.event;
    if ("room" in event && event.room !== roomPath) {
      return { result: "error", code: "malformed_params" };
    }

    const peerId = this.deps.getPeerId();
    this.deps.deliveryEngine.queueDelivery(peerId, event);
    this.deps.deliveryEngine.fireLocalDelivery(peerId, event);

    return { result: "ok" };
  }

  /**
   * Receiving side of a directed room.read (P3.5): verifies the presented token the same way handleRoomSend does, then for each read message-id in the batch, updates this store's own local copy of that message's readBy (this store holds one because it's the message's own author -- the reason it's the one being notified) and fires a delivery_status event locally, replacing what markRead used to broadcast via the legacy message_read patch. Read receipts stay voluntary and best-effort by design: a message-id this store doesn't recognise (already expired from history, or simply never this store's own) is silently skipped rather than treated as an error.
   */
  private async handleRoomRead(
    request: IncomingManageRequest,
    handle: Readonly<ConnectionHandle>,
  ): Promise<ManageOutcome> {
    const roomPath = request.scope.path;
    if (roomPath === undefined) {
      return { result: "error", code: "missing_scope_path" };
    }
    if (request.token === undefined) {
      return { result: "error", code: "unauthorized" };
    }
    const { identity, clock, revocation } = this.deps.requireIdentity();
    const verdict = await verifyRoomToken(request.token, {
      identity,
      clock,
      revocation,
      expectedBearer: deviceIdFromHex(handle.id),
      roomPath,
    });
    if (!verdict.ok) {
      return { result: "error", code: "unauthorized" };
    }

    const parsedParams = roomReadSchema.safeParse(request.command.params);
    if (!parsedParams.success) {
      return { result: "error", code: "malformed_params" };
    }
    const params = parsedParams.data;
    const isDm = parseRoomPath(roomPath).kind === "dm";
    const peerId = this.deps.getPeerId();

    for (const messageIdBytes of params.messages) {
      const messageId = bytesToHex(messageIdBytes);
      const history = isDm
        ? this.deps.dms.get(roomPath)
        : this.deps.messages.get(roomPath);
      const message = history?.find((m) => m.id === messageId);
      if (message === undefined) continue;
      if (!message.readBy.includes(handle.id)) {
        message.readBy.push(handle.id);
      }
      const event: DeliveryEvent = {
        type: "delivery_status",
        messageId,
        agent: handle.id,
        delivery: { status: "read" },
        ...(isDm ? {} : { room: roomPath }),
      };
      this.deps.deliveryEngine.queueDelivery(peerId, event);
      this.deps.deliveryEngine.fireLocalDelivery(peerId, event);
    }

    return { result: "ok" };
  }

  /**
   * Receiving side of room.members (P3.6): a plain membership + room-state refresh for an already-admitted member, verified the same way handleRoomSend/handleRoomRead are -- room.members grants nothing new, it just answers "who's here, and what's this room called" on demand, the same information room.join's own response already carries at admission time. A DM path has no Room record (this.rooms never holds one for a dm-shaped path) and no name/description/type to report, so its own members list is derived directly from the path's own two participants instead.
   */
  private async handleRoomMembers(
    request: IncomingManageRequest,
    handle: Readonly<ConnectionHandle>,
  ): Promise<ManageOutcome> {
    const roomPath = request.scope.path;
    if (roomPath === undefined) {
      return { result: "error", code: "missing_scope_path" };
    }
    if (request.token === undefined) {
      return { result: "error", code: "unauthorized" };
    }
    const { identity, clock, revocation } = this.deps.requireIdentity();
    const verdict = await verifyRoomToken(request.token, {
      identity,
      clock,
      revocation,
      expectedBearer: deviceIdFromHex(handle.id),
      roomPath,
    });
    if (!verdict.ok) {
      return { result: "error", code: "unauthorized" };
    }

    const parsedPath = parseRoomPath(roomPath);
    const room = this.deps.rooms.get(roomPath);
    const members =
      parsedPath.kind === "dm"
        ? parsedPath.participants.map((device) => ({
            device: deviceIdFromHex(device),
          }))
        : (room?.members ?? []).map((memberId) => ({
            device: deviceIdFromHex(memberId),
          }));

    return {
      result: "ok",
      members,
      ...roomStateExtension(room),
    };
  }

  /**
   * Sends one directed room.send to a single member's own session, attaching this store's own persisted room:member token for the given room path -- the primitive P3.5's own directed fan-out (deliverToRoom) will loop over per member once it replaces the legacy broadcastPatch path this store still uses for message delivery today. Throws if this store holds no token for the room: never a member, or a token that expired or was revoked with nothing fresh persisted in its place.
   */
  async sendRoomMessageDirected(
    roomPath: string,
    memberId: string,
    text: string,
  ): Promise<void> {
    const { slot, clock } = this.deps.requireIdentity();
    const token = loadRoomTokens(slot)[roomPath];
    if (token === undefined) {
      throw new CommsError(
        `No room:member token for ${roomPath}`,
        "NOT_A_MEMBER",
      );
    }
    const outcome = await this.deps.requireTransport().sendRoomRequest(
      memberId,
      {
        verb: ROOM_MEMBER_CAPABILITY,
        params: {
          verb: "room.send",
          "message-id": randomId(),
          "sent-at": clock.now(),
          text,
        },
      },
      { kind: "room", path: roomPath },
      token,
    );
    if (outcome.result !== "ok") {
      throw new CommsError(
        `room.send to ${memberId} for ${roomPath} failed (${outcome.code})`,
        "SEND_FAILED",
      );
    }
  }

  /** Tells this device's own agent what became of a message it sent, over the same delivery_status event read receipts already ride, so a queued, dropped, expired or refused message reaches the sender through the one path that already reports delivery. Does nothing for a request carrying no message of this sender's own (a room.read receipt, a room.notify), which has no message-id to report against. */
  private reportDelivery(
    memberId: string,
    entry: Readonly<Pick<PendingRoomRequest, "roomPath" | "messageId">>,
    delivery: MessageDelivery,
  ): void {
    if (entry.messageId === undefined) return;
    const peerId = this.deps.getPeerId();
    const isDm = parseRoomPath(entry.roomPath).kind === "dm";
    const event: DeliveryEvent = {
      type: "delivery_status",
      messageId: entry.messageId,
      agent: memberId,
      delivery,
      ...(isDm ? {} : { room: entry.roomPath }),
    };
    this.deps.deliveryEngine.queueDelivery(peerId, event);
    this.deps.deliveryEngine.fireLocalDelivery(peerId, event);
  }

  /** Holds a request for retry, evicting the oldest entries beyond the per-member bound and telling each evicted entry's sender the message was dropped, so a message given up on is never left looking merely pending. */
  private enqueuePendingRoomRequest(
    memberId: string,
    entry: PendingRoomRequest,
  ): void {
    const queue = this.pendingRoomRequests.get(memberId) ?? [];
    queue.push(entry);
    while (queue.length > MAX_PENDING_ROOM_REQUESTS_PER_MEMBER) {
      const evicted = queue.shift();
      if (evicted !== undefined) {
        this.reportDelivery(memberId, evicted, { status: "dropped" });
      }
    }
    this.pendingRoomRequests.set(memberId, queue);
  }

  /**
   * Gives up on every queued request older than the age bound, across every member, telling each one's sender it expired. Deliberately a sweep run from sendRoomRequestToMember and flushPendingRoomRequests rather than a timer: the queue only ever grows on a send and only ever drains on a flush, so those are exactly the moments an expired entry starts to matter, and nothing has to keep a timer alive for a member that may never come back.
   */
  private expirePendingRoomRequests(): void {
    // Nothing queued means nothing to sweep, and nothing to ask this store's identity for: a bridge with no identity yet still sees peers connect, and a sweep must not turn that into a rejected promise inside a fire-and-forget event handler.
    if (this.pendingRoomRequests.size === 0) return;
    const cutoff =
      this.deps.requireIdentity().clock.now() - PENDING_ROOM_REQUEST_TTL_MS;
    for (const [memberId, queue] of this.pendingRoomRequests) {
      const live = queue.filter((entry) => entry.queuedAt > cutoff);
      if (live.length === queue.length) continue;
      for (const entry of queue) {
        if (entry.queuedAt <= cutoff) {
          this.reportDelivery(memberId, entry, { status: "expired" });
        }
      }
      if (live.length === 0) this.pendingRoomRequests.delete(memberId);
      else this.pendingRoomRequests.set(memberId, live);
    }
  }

  /** One attempt at a directed room-domain request, with no queueing of its own: the raw wire outcome classified into delivered, undelivered (nobody answered, so a retry may still work) or refused (the member answered with a failure it will repeat). A rejection from the transport is the connection dropping mid-request, per wire-mesh-core's own rejectPendingManageRequests, which is the same "never answered" fact as a timeout. */
  private async attemptRoomRequest(
    memberId: string,
    roomPath: string,
    token: CapabilityToken,
    params: Record<string, unknown>,
  ): Promise<RoomRequestOutcome> {
    let outcome: ManageOutcome;
    try {
      outcome = await this.deps
        .requireTransport()
        .sendRoomRequest(
          memberId,
          { verb: ROOM_MEMBER_CAPABILITY, params },
          { kind: "room", path: roomPath },
          token,
        );
    } catch {
      return { kind: "undelivered", reason: "connection_lost" };
    }
    return classifyManageOutcome(outcome);
  }

  /**
   * Sends one directed room-domain request (room.send, room.read, or any future room:member-gated verb) to a single member and reports honestly what became of it -- the fan-out's own per-recipient primitive, distinct from sendRoomMessageDirected's deliberate throw-on-failure contract for a caller sending to one specific, known recipient. An undelivered request is held for retry and says so; a refused one is not queued at all, since the member has already answered with a failure it will give again, and its sender needs to know now rather than waiting on a retry that cannot help.
   */
  async sendRoomRequestToMember(
    memberId: string,
    roomPath: string,
    token: CapabilityToken,
    params: Record<string, unknown>,
  ): Promise<RoomRequestOutcome> {
    this.expirePendingRoomRequests();
    const outcome = await this.attemptRoomRequest(
      memberId,
      roomPath,
      token,
      params,
    );
    if (outcome.kind === "undelivered") {
      this.enqueuePendingRoomRequest(memberId, {
        roomPath,
        params,
        queuedAt: this.deps.requireIdentity().clock.now(),
        reason: outcome.reason,
        messageId: messageIdFromParams(params),
      });
    }
    return outcome;
  }

  /**
   * Retries every request queued for memberId since it was last reachable, and tells each one's sender what came of the retry: delivered, refused, or still undelivered and held for another attempt. An entry whose room this store no longer holds a token for can never be sent at all, so it is reported as dropped rather than retried forever. Called whenever memberId becomes reachable by any route -- a direct peer connection, or the hub admitting its device into this side's directory -- since a queued request cares only that some path to the member now exists, not which one.
   */
  async flushPendingRoomRequests(memberId: string): Promise<void> {
    this.expirePendingRoomRequests();
    const queue = this.pendingRoomRequests.get(memberId);
    if (queue === undefined || queue.length === 0) return;
    this.pendingRoomRequests.delete(memberId);
    const { slot } = this.deps.requireIdentity();
    for (const pending of queue) {
      const token = loadRoomTokens(slot)[pending.roomPath];
      if (token === undefined) {
        this.reportDelivery(memberId, pending, { status: "dropped" });
        continue;
      }
      const outcome = await this.attemptRoomRequest(
        memberId,
        pending.roomPath,
        token,
        pending.params,
      );
      if (outcome.kind === "delivered") {
        this.reportDelivery(memberId, pending, { status: "delivered" });
      } else if (outcome.kind === "refused") {
        this.reportDelivery(memberId, pending, {
          status: "refused",
          code: outcome.code,
        });
      } else {
        // Re-queued with its original queuedAt, never a fresh one: a member that keeps briefly reappearing and failing must not be able to keep a message pending past the age bound.
        this.enqueuePendingRoomRequest(memberId, {
          ...pending,
          reason: outcome.reason,
        });
      }
    }
  }

  /**
   * Owner-side admission for an incoming room.join request, against either a named room this store owns or a DM path this store is a participant of. Named-room admission always needs a human decision; DM admission needs one only for the party being contacted first -- the reply half of the two-round consent flow (section 6) auto-approves, since a reply on a path this node itself opened is not unsolicited contact, and so does a request presenting a valid dm:send capability this node's own user principal already issued the requester (agent-comms#162's own durable admission list, checked before ever falling through to a fresh human decision).
   */
  private async handleRoomJoin(
    request: IncomingManageRequest,
    handle: Readonly<ConnectionHandle>,
  ): Promise<ManageOutcome> {
    const roomPath = request.scope.path;
    if (roomPath === undefined) {
      return { result: "error", code: "missing_scope_path" };
    }
    const parsed = parseRoomPath(roomPath);
    const peerId = this.deps.getPeerId();

    if (parsed.kind === "owner-named") {
      if (parsed.owner !== peerId) {
        return { result: "error", code: "not_owner" };
      }
      return this.admitRoomJoin(roomPath, handle, false);
    }

    if (!parsed.participants.includes(peerId)) {
      return { result: "error", code: "not_participant" };
    }

    // A presented dm:send grant is this node's own user principal admitting the requester ahead of time (agent-comms#162) -- verify it against that principal specifically (never this bridge slot's own device identity, the way an ordinary room:member grant is) and auto-admit on success. A token that fails this check is refused outright: it identifies the requester as claiming durable admission it does not actually hold, not as an ordinary unsolicited contact that still deserves a human decision.
    if (request.token !== undefined) {
      const { identity, clock, revocation, userIdentity } =
        this.deps.requireIdentity();
      const verdict = await verifyDmSendToken(request.token, {
        identity,
        clock,
        revocation,
        expectedBearer: deviceIdFromHex(handle.id),
        userPrincipalDeviceId: userIdentity.deviceId,
      });
      if (!verdict.ok) {
        return { result: "error", code: "unauthorized" };
      }
      return this.admitRoomJoin(roomPath, handle, true);
    }

    // The reciprocal half of section 6's own two-round DM flow: this node's own outbound room.join to the same path (recorded by joinRemoteRoom before this response was even awaited) is the consent that makes the counterpart's own reply not unsolicited contact.
    const autoApprove = this.deps.dmRequestsInitiatedByMe.has(roomPath);
    return this.admitRoomJoin(roomPath, handle, autoApprove);
  }

  /** Tells this device's own agent a room.join is now waiting on its decision (accept with room_accept, refuse with room_reject), so a request held open for a human decision is never sitting unseen in pendingRoomJoins. */
  private announcePendingRoomJoin(roomPath: string, requesterId: string): void {
    const peerId = this.deps.getPeerId();
    const event: DeliveryEvent = {
      type: "room_join_request",
      room: roomPath,
      requesterId,
    };
    this.deps.deliveryEngine.queueDelivery(peerId, event);
    this.deps.deliveryEngine.fireLocalDelivery(peerId, event);
  }

  /** Shared admission continuation for both room.join branches above: waits for a human decision (unless auto-approved), then mints and returns the requester's own independent, parent-less room:member grant. */
  private async admitRoomJoin(
    roomPath: string,
    handle: Readonly<ConnectionHandle>,
    autoApprove: boolean,
  ): Promise<ManageOutcome> {
    const decision: RoomJoinDecision = autoApprove
      ? { kind: "accept" }
      : await new Promise<RoomJoinDecision>((resolve) => {
          // Expires the request if no decision arrives in time, so an unanswered one neither leaks in pendingRoomJoins nor leaves the requester waiting. unref: an undecided request must not keep the process alive.
          const expiry = setTimeout(() => {
            resolve({ kind: "expired" });
          }, this.deps.joinDecisionTimeoutMs);
          expiry.unref();
          this.pendingRoomJoins.set(`${roomPath}::${handle.id}`, {
            roomPath,
            requesterId: handle.id,
            resolve: (answer) => {
              clearTimeout(expiry);
              resolve(answer);
            },
          });
          this.announcePendingRoomJoin(roomPath, handle.id);
        });
    if (!autoApprove) this.pendingRoomJoins.delete(`${roomPath}::${handle.id}`);
    if (decision.kind === "expired") {
      return { result: "error", code: "timeout" };
    }
    if (decision.kind === "reject") {
      return {
        result: "error",
        code: "denied",
        ...(decision.reason !== undefined ? { message: decision.reason } : {}),
      };
    }

    // The granted token itself belongs to the requester's own node, which persists it itself once it receives this response -- but this identity slot must also remember the token-id it just issued (saveIssuedRoomGrant below), since revoking a specific member's grant later (kickFromRoom) has no other way to name which token-id to revoke: a token-id is never presented back on the wire, so a room owner's own memory of having minted it is the only record.
    const { identity, clock, slot } = this.deps.requireIdentity();
    const tokenId = randomId();
    const verdict = await mintCapabilityToken({
      identity,
      clock,
      tokenId,
      bearer: deviceIdFromHex(handle.id),
      capability: ROOM_MEMBER_CAPABILITY,
      scope: { kind: "room", path: roomPath },
      expires: clock.now() + ROOM_TOKEN_LIFETIME_MS,
      delegationsRemaining: resolveDelegationsRemaining(
        ROOM_MEMBER_DELEGATION_POLICY,
        ROOM_MEMBER_CAPABILITY,
        handle.id,
        0,
      ),
    });
    if (!verdict.ok) {
      return { result: "error", code: "mint_failed" };
    }
    saveIssuedRoomGrant(slot, roomPath, handle.id, tokenId);

    const room = this.deps.rooms.get(roomPath);
    if (room !== undefined) {
      this.deps.deliveryEngine.bump(room);
      this.deps.deliveryEngine.recordMemberOp(
        room,
        "member",
        "join",
        handle.id,
      );
      this.deps.deliveryEngine.refreshMembership(room);
      this.deps.rooms.set(roomPath, room);
    }

    const members = (room?.members ?? [this.deps.getPeerId(), handle.id]).map(
      (memberId) => ({ device: deviceIdFromHex(memberId) }),
    );
    return {
      result: "ok",
      "granted-token": verdict.token,
      members,
      ...roomStateExtension(room),
    };
  }

  /**
   * Receiving side of a real, wire-level room.invite (P3.8): unlike every other room verb, the request itself is deliberately ungated (the sender already IS the room's own owner, with no need to prove capability to invite) -- the security instead lives entirely in the embedded params.token, which must genuinely name this store's own identity as bearer and root at the room path's own claimed owner. Persists the verified token via saveRoomToken (mirroring joinRemoteRoom's own persistence) and fires a local room_invite delivery event carrying the room's real name/description (room-state) and the inviter's real name/cwd (inviter-agent) when the sender includes them, falling back to the bare device-id and room path otherwise.
   */
  private async handleRoomInvite(
    request: IncomingManageRequest,
  ): Promise<ManageOutcome> {
    const roomPath = request.scope.path;
    if (roomPath === undefined) {
      return { result: "error", code: "missing_scope_path" };
    }
    const parsedParams = roomInviteSchema.safeParse(request.command.params);
    if (!parsedParams.success) {
      return { result: "error", code: "malformed_params" };
    }
    const { token } = parsedParams.data;
    const peerId = this.deps.getPeerId();

    const { identity, clock, slot, revocation } = this.deps.requireIdentity();
    const verdict = await verifyRoomToken(token, {
      identity,
      clock,
      revocation,
      expectedBearer: deviceIdFromHex(peerId),
      roomPath,
    });
    if (!verdict.ok) {
      return { result: "error", code: "unauthorized" };
    }
    saveRoomToken(slot, roomPath, token);

    const parsed = parseRoomPath(roomPath);
    const inviterId = parsed.kind === "owner-named" ? parsed.owner : peerId;
    const roomState = parseRoomStateExtension(parsedParams.data["room-state"]);
    const inviterAgent = parseInviterAgentExtension(
      parsedParams.data["inviter-agent"],
    );
    const event: DeliveryEvent = {
      type: "room_invite",
      room: roomPath,
      roomDescription: roomState?.description ?? "",
      from: inviterId,
      fromName: inviterAgent?.name ?? inviterId,
      fromCwd: inviterAgent?.cwd ?? "",
    };
    this.deps.deliveryEngine.queueDelivery(peerId, event);
    this.deps.deliveryEngine.fireLocalDelivery(peerId, event);

    return { result: "ok" };
  }

  /**
   * Receiving side of a real, wire-level room.leave (P3.8), covering both an actual member leaving and a decline of a never-joined invite -- the same wire request either way, since both are "give up a room:member grant I hold," per leaveRemoteRoom's own reasoning. Distinguishes the two purely from this store's own membership/invited lists (never from anything the sender claims), revokes the sender's grant for real via revokeMemberGrant, and notifies accordingly: member_left broadcast to the room's other members for a real leave, a local invite_declined event (carrying the sender's own optional reason extension) for a decline -- there is no third party to notify for a decline, since nobody else ever knew about an invite that was never accepted.
   */
  private async handleRoomLeave(
    request: IncomingManageRequest,
    handle: Readonly<ConnectionHandle>,
  ): Promise<ManageOutcome> {
    const roomPath = request.scope.path;
    if (roomPath === undefined) {
      return { result: "error", code: "missing_scope_path" };
    }
    if (request.token === undefined) {
      return { result: "error", code: "unauthorized" };
    }
    const { identity, clock, revocation } = this.deps.requireIdentity();
    const verdict = await verifyRoomToken(request.token, {
      identity,
      clock,
      revocation,
      expectedBearer: deviceIdFromHex(handle.id),
      roomPath,
    });
    if (!verdict.ok) {
      return { result: "error", code: "unauthorized" };
    }
    const parsedParams = roomLeaveSchema.safeParse(request.command.params);
    if (!parsedParams.success) {
      return { result: "error", code: "malformed_params" };
    }

    const room = this.deps.rooms.get(roomPath);
    if (room === undefined) {
      return { result: "error", code: "room_not_found" };
    }
    const wasMember = room.members.includes(handle.id);
    const wasInvited = room.invited.includes(handle.id);
    if (!wasMember && !wasInvited) {
      return { result: "ok" };
    }

    await this.deps.revokeMemberGrant(roomPath, handle.id);

    this.deps.deliveryEngine.bump(room);
    if (wasMember)
      this.deps.deliveryEngine.recordMemberOp(
        room,
        "member",
        "leave",
        handle.id,
      );
    if (wasInvited)
      this.deps.deliveryEngine.recordMemberOp(
        room,
        "invited",
        "leave",
        handle.id,
      );
    this.deps.deliveryEngine.refreshMembership(room);
    this.deps.rooms.set(roomPath, room);
    await this.deps.deliveryEngine.broadcastPatch({
      type: "room_upsert",
      room,
    });

    const peerId = this.deps.getPeerId();
    if (wasMember) {
      await this.deps.deliveryEngine.deliverToRoom(
        roomPath,
        { type: "member_left", room: roomPath, agent: handle.id },
        handle.id,
      );
    } else {
      const reasonValue = parsedParams.data.reason;
      const decliner = this.deps.agents.get(handle.id);
      const event: DeliveryEvent = {
        type: "invite_declined",
        room: roomPath,
        agent: handle.id,
        agentName: decliner?.name ?? handle.id,
        reason: typeof reasonValue === "string" ? reasonValue : "",
      };
      this.deps.deliveryEngine.queueDelivery(peerId, event);
      this.deps.deliveryEngine.fireLocalDelivery(peerId, event);
    }

    return { result: "ok" };
  }

  /** Every room.join request currently held open awaiting this store's own accept/reject decision. */
  listPendingRoomJoins(): { roomPath: string; requesterId: string }[] {
    return [...this.pendingRoomJoins.values()].map(
      ({ roomPath, requesterId }) => ({ roomPath, requesterId }),
    );
  }

  /** Approves a pending room.join request, resuming handleRoomJoin's own suspended mint-and-respond continuation. */
  acceptRoomJoin(roomPath: string, requesterId: string): void {
    const key = `${roomPath}::${requesterId}`;
    const pending = this.pendingRoomJoins.get(key);
    if (pending === undefined) {
      throw new CommsError(
        `No pending room.join for ${requesterId} on ${roomPath}`,
        "NOT_PENDING",
      );
    }
    pending.resolve({ kind: "accept" });
  }

  /** Denies a pending room.join request, optionally with a reason surfaced to the requester in the resulting manage-error's own message field. */
  rejectRoomJoin(roomPath: string, requesterId: string, reason?: string): void {
    const key = `${roomPath}::${requesterId}`;
    const pending = this.pendingRoomJoins.get(key);
    if (pending === undefined) {
      throw new CommsError(
        `No pending room.join for ${requesterId} on ${roomPath}`,
        "NOT_PENDING",
      );
    }
    pending.resolve({
      kind: "reject",
      ...(reason !== undefined ? { reason } : {}),
    });
  }
}

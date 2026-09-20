/**
 * RoomMessaging — the sending side of room messages and DMs: sendRoomMessage/sendDm fan out one directed, wire-authenticated room.send per member via RoomProtocol's own retry-queueing sendRoomRequestToMember (P3.5), and readRoomMessages reads back a room's local history. Split out of mesh-store.ts to reduce it under the repo's max-lines cap.
 */

import { bytesFromHex, bytesToHex } from "wire-mesh-core/domain/device-id";
import { dmRoomPath } from "./room-path.js";
import { loadRoomTokens } from "./identity-store.js";
import { randomId } from "./random-id.js";
import { recordRoomSendNotice } from "./room-notice-log.js";
import { CommsError } from "./store.js";
import { describeRefusal } from "./send-outcome.js";
import type { RoomRequestOutcome } from "./send-outcome.js";
import type { MeshStoreIdentity } from "./mesh-store-shared.js";
import type { RoomProtocol } from "./room-protocol.js";
import type { CapabilityToken } from "wire-mesh-core/generated/protocol";
import type {
  AgentIdentity,
  DmMessage,
  MessageDelivery,
  Room,
  RoomMessage,
  StreamingBehavior,
} from "./types.js";
import type {
  MemberDelivery,
  SentDm,
  SentRoomMessage,
  SendRoomMessageOptions,
} from "./comms-store.js";

/** Turns one member's send outcome into the delivery state its sender is told about. A refusal is not represented here at all: a refused send raises rather than resolving, so this only ever maps the two states a resolved send can be in. */
function deliveryFromOutcome(
  outcome: Readonly<Exclude<RoomRequestOutcome, { kind: "refused" }>>,
): MessageDelivery {
  return outcome.kind === "delivered"
    ? { status: "delivered" }
    : { status: "queued", reason: outcome.reason };
}

/** The state and collaborators RoomMessaging needs from MeshStore. rooms/messages/dms are direct references into MeshStore's own fields; roomProtocol is the already-constructed instance (construction order: ... -\> roomProtocol -\> roomMessaging -\> ...), narrowed to what sending a message or DM ever needs; resolveAgent is AgentRegistry's own getAgent (deferred the same lazy-closure way DeliveryEngine's sendRoomRequestToMember closure is, since AgentRegistry doesn't exist yet at RoomMessaging's own construction point) rather than a bare `agents.get` lookup, so sendDm's own existence check also resolves a gossip-discovered agent (a remote, hub-learned one included, agent-comms#155) that will never appear in the agents map directly. */
export interface RoomMessagingDeps {
  rooms: Map<string, Room>;
  messages: Map<string, RoomMessage[]>;
  dms: Map<string, DmMessage[]>;
  requireIdentity: () => MeshStoreIdentity;
  roomProtocol: Pick<RoomProtocol, "sendRoomRequestToMember">;
  /** Runs the requester half of the DM consent flow against a counterpart device (RoomLifecycle.requestDmAccess), persisting the room:member token it is granted. Resolves once the counterpart admits this device, rejects if it refuses or never answers. */
  requestDmAccess: (counterpart: string) => Promise<void>;
  /** Resolves a room id or plain room name to a real room id (RoomLifecycle.resolveRoomId), against rooms this store holds and rooms other devices advertise as hosted, so a name means the same room here as it does to join_room. Throws AMBIGUOUS_ROOM_NAME when the name is shared by more than one room. */
  resolveRoomId: (roomIdOrName: string) => string;
  resolveAgent: (id: string) => Promise<AgentIdentity | undefined>;
}

/** RoomMessaging's own richer sendRoomMessage options, extending the public CommsStore-facing SendRoomMessageOptions with durable -- see sendRoomMessage's own doc comment for what durable means. */
export interface RoomMessagingSendOptions extends SendRoomMessageOptions {
  durable?: boolean;
}

export class RoomMessaging {
  constructor(private readonly deps: RoomMessagingDeps) {}

  /**
   * Sends a room message via a real, wire-authenticated room.send fan-out (P3.5): one directed request per member, each carrying this sender's own persisted room:member token, rather than the legacy broadcastPatch's full-state replication. A member unreachable right now is queued for retry (see sendRoomRequestToMember/flushPendingRoomRequests) instead of blocking or failing the whole send -- delivery to any one recipient is independent of every other.
   *
   * durable, when true, additionally records this same message as a room-notice in the sender's own oplog via recordRoomSendNotice (P5, agent-comms#50) -- deliberately opt-in per call, not automatic: matching this codebase's own design principle that delivery and durable catch-up are the same artifact only when a caller actually opts a message into it. A caller that wants an offline member to be able to catch up on this specific message later passes true; every other send stays exactly as before.
   *
   * Returns the message alongside one delivery state per remote member, so the caller can tell who actually received it from who it is merely queued for. A member that refuses the message outright raises: a refusal is the member's settled answer, not a state to report as pending, and a fan-out whose members cannot all be reported honestly is not a successful send.
   */
  async sendRoomMessage(
    roomIdOrName: string,
    from: string,
    content: string,
    options?: RoomMessagingSendOptions,
  ): Promise<SentRoomMessage> {
    const { replyTo, streamingBehavior, durable } = options ?? {};
    const roomId = this.deps.resolveRoomId(roomIdOrName);
    const room = this.deps.rooms.get(roomId);
    if (!room)
      throw new CommsError(`Room ${roomId} not found`, "ROOM_NOT_FOUND");
    if (!room.members.includes(from))
      throw new CommsError(`Not a member of ${roomId}`, "NOT_MEMBER");

    const { slot, clock, identity, dataStorage } = this.deps.requireIdentity();
    const token = loadRoomTokens(slot)[roomId];
    if (token === undefined) {
      throw new CommsError(`No room:member token for ${roomId}`, "NOT_MEMBER");
    }

    if (durable === true) {
      await recordRoomSendNotice(
        { identity, clock, storage: dataStorage },
        {
          room: roomId,
          token,
          contentType: "text/plain",
          content: new TextEncoder().encode(content),
        },
      );
    }

    const messageId = randomId();
    const id = bytesToHex(messageId);
    const message: RoomMessage = {
      id,
      from,
      room: roomId,
      content,
      timestamp: new Date().toISOString(),
      readBy: [from],
      ...(replyTo !== undefined && { replyTo }),
      ...(streamingBehavior !== undefined && { streamingBehavior }),
    };

    const arr = this.deps.messages.get(roomId) ?? [];
    arr.push(message);
    this.deps.messages.set(roomId, arr);

    const params: Record<string, unknown> = {
      verb: "room.send",
      "message-id": messageId,
      "sent-at": clock.now(),
      text: content,
      ...(replyTo !== undefined && {
        refs: [{ id: bytesFromHex(replyTo), relation: "reply" }],
      }),
      ...(streamingBehavior !== undefined && {
        "streaming-behavior": streamingBehavior,
      }),
    };

    const deliveries: MemberDelivery[] = [];
    for (const memberId of room.members) {
      if (memberId === from) continue;
      const outcome = await this.deps.roomProtocol.sendRoomRequestToMember(
        memberId,
        roomId,
        token,
        params,
      );
      // A refusal is reported as this member's own delivery state rather than raised, unlike sendDm's single recipient: delivery to any one member is independent of every other, so one member's refusal must neither stop the message reaching the rest nor discard what became of them.
      deliveries.push({
        member: memberId,
        delivery:
          outcome.kind === "refused"
            ? { status: "refused", code: describeRefusal(outcome) }
            : deliveryFromOutcome(outcome),
      });
    }

    return { message, deliveries };
  }

  async readRoomMessages(
    roomIdOrName: string,
    since?: string,
  ): Promise<RoomMessage[]> {
    await Promise.resolve();
    const roomId = this.deps.resolveRoomId(roomIdOrName);
    const arr = this.deps.messages.get(roomId) ?? [];
    if (since === undefined || since === "") return [...arr];
    return arr.filter((m) => m.timestamp > since);
  }

  /**
   * Sends a DM via the same wire-authenticated room.send fan-out sendRoomMessage uses (P3.5): a DM is just a dm-shaped room path with exactly one other member, so it rides the identical mechanism rather than a separate one. Self-DM is the one exception -- a purely local scratchpad note that never leaves the process, so it needs no token and no wire round trip at all, and is delivered the moment it is recorded.
   *
   * Returns the message alongside what actually became of it, so a caller can never mistake a message merely held for retry for one the recipient received. A recipient that refuses the message raises SEND_REFUSED naming its own reason: a DM has exactly one recipient, so its refusal is the whole send failing, and no retry will change it.
   */
  async sendDm(
    from: string,
    to: string,
    content: string,
    streamingBehavior?: StreamingBehavior,
  ): Promise<SentDm> {
    if (to !== from) {
      const recipient = await this.deps.resolveAgent(to);
      if (!recipient)
        throw new CommsError(`Agent ${to} not found`, "AGENT_NOT_FOUND");
      if (recipient.visibility === "ghost")
        throw new CommsError(`Cannot DM agent ${to}`, "AGENT_NOT_FOUND");
    }

    // A cross-device DM needs a room:member token for the pair's dm path. The first message to a counterpart has none yet, so obtain one via the consent flow before anything is recorded or sent: a refused or unanswered request must leave no trace of a message that never went out.
    const token =
      to === from ? undefined : await this.dmRoomMemberToken(from, to);

    const messageId = randomId();
    const id = bytesToHex(messageId);
    const message: DmMessage = {
      id,
      from,
      to,
      content,
      timestamp: new Date().toISOString(),
      readBy: [from],
      ...(streamingBehavior !== undefined && { streamingBehavior }),
    };

    // Self-DM is a purely local scratchpad note -- it never leaves the process, so it needs no room-path and dmRoomPath's own a===b refusal (a path naming the same device twice is not a valid DM path at all) correctly does not apply.
    const key = to === from ? `self:${from}` : dmRoomPath(from, to);
    const arr = this.deps.dms.get(key) ?? [];
    arr.push(message);
    this.deps.dms.set(key, arr);

    // A self-DM never leaves the process, so it is already exactly as delivered as it will ever be by the time it is recorded above.
    if (token === undefined)
      return { message, delivery: { status: "delivered" } };

    const { clock } = this.deps.requireIdentity();
    const params: Record<string, unknown> = {
      verb: "room.send",
      "message-id": messageId,
      "sent-at": clock.now(),
      text: content,
      ...(streamingBehavior !== undefined && {
        "streaming-behavior": streamingBehavior,
      }),
    };
    const outcome = await this.deps.roomProtocol.sendRoomRequestToMember(
      to,
      key,
      token,
      params,
    );
    if (outcome.kind === "refused") {
      throw new CommsError(
        `DM to ${to} refused (${describeRefusal(outcome)})`,
        "SEND_REFUSED",
      );
    }

    return { message, delivery: deliveryFromOutcome(outcome) };
  }

  /** The room:member token this device holds for its DM path with `to`, requesting DM access from `to` first when none is persisted yet. Throws NOT_MEMBER if the request resolves without a token having been persisted, since no send can be authenticated without one. */
  private async dmRoomMemberToken(
    from: string,
    to: string,
  ): Promise<CapabilityToken> {
    const key = dmRoomPath(from, to);
    const { slot } = this.deps.requireIdentity();
    const existing = loadRoomTokens(slot)[key];
    if (existing !== undefined) return existing;

    await this.deps.requestDmAccess(to);
    const granted = loadRoomTokens(slot)[key];
    if (granted === undefined) {
      throw new CommsError(`No room:member token for ${key}`, "NOT_MEMBER");
    }
    return granted;
  }
}

/**
 * RoomMessaging — the sending side of room messages and DMs: sendRoomMessage/sendDm fan out one directed, wire-authenticated room.send per member via RoomProtocol's own retry-queueing sendRoomRequestToMember (P3.5), and readRoomMessages reads back a room's local history. Split out of mesh-store.ts to reduce it under the repo's max-lines cap.
 */

import { bytesFromHex, bytesToHex } from "wire-mesh-core/domain/device-id";
import { dmRoomPath } from "./room-path.js";
import { loadRoomTokens } from "./identity-store.js";
import { randomId } from "./random-id.js";
import { recordRoomSendNotice } from "./room-notice-log.js";
import { CommsError } from "./store.js";
import type { MeshStoreIdentity } from "./mesh-store-shared.js";
import type { RoomProtocol } from "./room-protocol.js";
import type {
  AgentIdentity,
  DmMessage,
  Room,
  RoomMessage,
  StreamingBehavior,
} from "./types.js";

/** The state and collaborators RoomMessaging needs from MeshStore. rooms/messages/dms/agents are direct references into MeshStore's own fields; roomProtocol is the already-constructed instance (construction order: ... -\> roomProtocol -\> roomMessaging -\> ...), narrowed to what sending a message or DM ever needs. */
export interface RoomMessagingDeps {
  rooms: Map<string, Room>;
  messages: Map<string, RoomMessage[]>;
  dms: Map<string, DmMessage[]>;
  agents: Map<string, AgentIdentity>;
  requireIdentity: () => MeshStoreIdentity;
  roomProtocol: Pick<RoomProtocol, "sendRoomRequestToMember">;
}

export class RoomMessaging {
  constructor(private readonly deps: RoomMessagingDeps) {}

  /**
   * Sends a room message via a real, wire-authenticated room.send fan-out (P3.5): one directed request per member, each carrying this sender's own persisted room:member token, rather than the legacy broadcastPatch's full-state replication. A member unreachable right now is queued for retry (see sendRoomRequestToMember/flushPendingRoomRequests) instead of blocking or failing the whole send -- delivery to any one recipient is independent of every other.
   *
   * durable, when true, additionally records this same message as a room-notice in the sender's own oplog via recordRoomSendNotice (P5, agent-comms#50) -- deliberately opt-in per call, not automatic: matching this codebase's own design principle that delivery and durable catch-up are the same artifact only when a caller actually opts a message into it. A caller that wants an offline member to be able to catch up on this specific message later passes true; every other send stays exactly as before.
   */
  async sendRoomMessage(
    roomId: string,
    from: string,
    content: string,
    replyTo?: string,
    streamingBehavior?: StreamingBehavior,
    durable?: boolean,
  ): Promise<RoomMessage> {
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

    for (const memberId of room.members) {
      if (memberId !== from) {
        await this.deps.roomProtocol.sendRoomRequestToMember(
          memberId,
          roomId,
          token,
          params,
        );
      }
    }

    return message;
  }

  async readRoomMessages(
    roomId: string,
    since?: string,
  ): Promise<RoomMessage[]> {
    await Promise.resolve();
    const arr = this.deps.messages.get(roomId) ?? [];
    if (since === undefined || since === "") return [...arr];
    return arr.filter((m) => m.timestamp > since);
  }

  /**
   * Sends a DM via the same wire-authenticated room.send fan-out sendRoomMessage uses (P3.5): a DM is just a dm-shaped room path with exactly one other member, so it rides the identical mechanism rather than a separate one. Self-DM is the one exception -- a purely local scratchpad note that never leaves the process, so it needs no token and no wire round trip at all.
   */
  async sendDm(
    from: string,
    to: string,
    content: string,
    streamingBehavior?: StreamingBehavior,
  ): Promise<DmMessage> {
    if (to !== from) {
      const recipient = this.deps.agents.get(to);
      if (!recipient)
        throw new CommsError(`Agent ${to} not found`, "AGENT_NOT_FOUND");
      if (recipient.visibility === "ghost")
        throw new CommsError(`Cannot DM agent ${to}`, "AGENT_NOT_FOUND");
    }

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

    // Self-DM is a purely local scratchpad note -- it never leaves the process, so it needs no room-path and dmRoomPath's own a===b refusal (a path naming the same device twice is not a valid DM path at all) correctly does not apply here.
    const key = to === from ? `self:${from}` : dmRoomPath(from, to);
    const arr = this.deps.dms.get(key) ?? [];
    arr.push(message);
    this.deps.dms.set(key, arr);

    if (to !== from) {
      const { slot, clock } = this.deps.requireIdentity();
      const token = loadRoomTokens(slot)[key];
      if (token === undefined) {
        throw new CommsError(`No room:member token for ${key}`, "NOT_MEMBER");
      }
      const params: Record<string, unknown> = {
        verb: "room.send",
        "message-id": messageId,
        "sent-at": clock.now(),
        text: content,
        ...(streamingBehavior !== undefined && {
          "streaming-behavior": streamingBehavior,
        }),
      };
      await this.deps.roomProtocol.sendRoomRequestToMember(
        to,
        key,
        token,
        params,
      );
    }

    return message;
  }
}

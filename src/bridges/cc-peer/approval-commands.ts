/**
 * Lets a cc-peer session answer a room join or first-contact DM request. A session reached only through cc-peer (no agent-comms tool of its own) cannot call room_accept or room_reject, so the relayed request tells it exactly what to message back, and the relay runs the same tool action when that message arrives. The person at the session decides: only a message from that session's own socket ever reaches its relay.
 */

import { buildAction, formatDeliveryEvent } from "../../core/bridge.js";
import type { CommsContext, CommsTool } from "../../core/tool.js";
import type { DeliveryEvent } from "../../core/types.js";

/** A device-id is a 64-character lowercase hex SHA-256 digest. */
const DEVICE_ID_HEX = "[0-9a-f]{64}";

/** `accept <room> <requester>` or `reject <room> <requester> [reason]`, the whole message and nothing else, so an ordinary message that merely mentions the word is never mistaken for a decision. */
const APPROVAL_COMMAND = new RegExp(
  `^\\s*(accept|reject)\\s+(\\S+)\\s+(${DEVICE_ID_HEX})(?:\\s+(\\S[\\s\\S]*?))?\\s*$`,
  "i",
);

export type ApprovalCommand =
  | { kind: "accept"; room: string; requesterId: string }
  | { kind: "reject"; room: string; requesterId: string; reason?: string };

/** The command a message body is, or undefined when it is not a well-formed one. */
export function parseApprovalCommand(
  body: string,
): ApprovalCommand | undefined {
  const match = APPROVAL_COMMAND.exec(body);
  if (match === null) return undefined;
  const [, verb, room, requesterId, reason] = match;
  if (verb === undefined || room === undefined || requesterId === undefined) {
    return undefined;
  }
  if (verb.toLowerCase() === "accept") {
    return { kind: "accept", room, requesterId: requesterId.toLowerCase() };
  }
  return {
    kind: "reject",
    room,
    requesterId: requesterId.toLowerCase(),
    ...(reason !== undefined ? { reason } : {}),
  };
}

/** Renders a delivery event for a cc-peer session. A join request carries the instructions for answering it through `peerName`, the peer the session should message; every other event renders as the shared formatter does. */
export function formatCcPeerDelivery(
  event: DeliveryEvent,
  peerName: string,
): string {
  if (event.type !== "room_join_request") return formatDeliveryEvent(event);
  return [
    `${event.requesterId} is asking to join ${event.room}.`,
    `To answer, send the peer "${peerName}" one of these messages:`,
    `accept ${event.room} ${event.requesterId}`,
    `reject ${event.room} ${event.requesterId} <optional reason>`,
  ].join("\n");
}

export interface AnswerJoinRequestDeps {
  tool: Pick<CommsTool, "handle">;
  ctx: Readonly<CommsContext>;
}

/** Runs the room_accept or room_reject the command asks for as this session's own agent, and returns the tool's own text so the session learns what happened, including why a decision failed. */
export async function answerJoinRequest(
  deps: Readonly<AnswerJoinRequestDeps>,
  command: Readonly<ApprovalCommand>,
): Promise<string> {
  const action =
    command.kind === "accept"
      ? buildAction({
          action: "room_accept",
          room: command.room,
          requesterId: command.requesterId,
        })
      : buildAction({
          action: "room_reject",
          room: command.room,
          requesterId: command.requesterId,
          ...(command.reason !== undefined ? { reason: command.reason } : {}),
        });
  const result = await deps.tool.handle(deps.ctx, action);
  return result.content;
}

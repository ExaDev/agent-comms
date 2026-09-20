/**
 * send-outcome -- classifies what actually happened to one directed room-domain request, so a caller can tell a delivery from a message that is merely held for retry and from one the recipient refused outright. The distinction that matters is whether trying again could ever change the answer: a deadline that passed or a route that did not exist may succeed on the next attempt, while a refusal (an unverifiable token, an unknown verb, a denied decision) is the recipient's settled answer and will be repeated every time.
 */

import type { ManageOutcome } from "wire-mesh-core/domain/mesh-session";
import type { MessageDelivery, TransientSendFailure } from "./types.js";

/** Wire error codes that name a failure to reach the recipient at all, rather than an answer from it. Everything else, including a code this version does not recognise, is treated as a refusal: a send whose failure cannot be explained is reported to its sender now rather than queued to fail again unseen. */
const TRANSIENT_OUTCOME_CODES: ReadonlyMap<string, TransientSendFailure> =
  new Map([
    ["timeout", "timeout"],
    ["not_connected", "not_connected"],
    // This side's own transport answering that it has nowhere to send the request (no session, and no gateway willing to relay for that device). Reported as not_connected because that is exactly what it means to the sender: no route to the recipient existed when the request was attempted.
    ["no_route", "not_connected"],
  ]);

/**
 * What became of one directed room-domain request. `undelivered` is the retryable class: the recipient never answered, so the request may still succeed later and is worth holding. `refused` is terminal: the recipient did answer, with a failure it will give again, so the sender is told now rather than waiting on a retry that cannot help.
 */
export type RoomRequestOutcome =
  | { kind: "delivered" }
  | { kind: "undelivered"; reason: TransientSendFailure }
  | { kind: "refused"; code: string; message?: string };

/** Classifies a wire manage-outcome into the three states above. A non-ok outcome whose code names an unreached recipient is undelivered; every other non-ok outcome is a refusal carrying the recipient's own code, and its own message when it sent one (a rejected room.join carries the refuser's stated reason there), so the sender can be told exactly what it was refused with. */
export function classifyManageOutcome(
  outcome: Readonly<ManageOutcome>,
): RoomRequestOutcome {
  if (outcome.result === "ok") return { kind: "delivered" };
  const reason = TRANSIENT_OUTCOME_CODES.get(outcome.code);
  if (reason !== undefined) return { kind: "undelivered", reason };
  return {
    kind: "refused",
    code: outcome.code,
    ...(outcome.message !== undefined && { message: outcome.message }),
  };
}

/** A one-line, human-readable rendering of a refusal for an error message or a tool result: the recipient's own code, plus the message it sent when it sent one. */
export function describeRefusal(
  outcome: Readonly<{ code: string; message?: string }>,
): string {
  return outcome.message === undefined
    ? outcome.code
    : `${outcome.code}: ${outcome.message}`;
}

/** A one-line, human-readable rendering of what became of a message for one recipient, phrased to read as a clause after the message's own id ("read by a1b2c3", "queued for a1b2c3 (timeout), not yet delivered"). Shared by every surface that reports a delivery status, so a tool result, a terminal line and a browser line never describe the same state differently. */
export function describeDeliveryFor(
  delivery: Readonly<MessageDelivery>,
  agent: string,
): string {
  switch (delivery.status) {
    case "delivered":
      return `delivered to ${agent}`;
    case "read":
      return `read by ${agent}`;
    case "queued":
      return `queued for ${agent} (${delivery.reason}), not yet delivered`;
    case "refused":
      return `refused by ${agent} (${delivery.code})`;
    case "dropped":
      return `dropped for ${agent}, never delivered`;
    case "expired":
      return `expired for ${agent}, never delivered`;
    default:
      return delivery satisfies never;
  }
}

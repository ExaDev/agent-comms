/**
 * Deadlines for manage-requests sent to another device. A request that waits on a human decision needs a far longer window than one answered by code, and every request needs some bound: wire-mesh-core waits forever for a response unless it is given a timeout.
 */

import type { ManageCommand } from "wire-mesh-core/generated/protocol";

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;

const ROOM_REQUEST_TIMEOUT_SECONDS = 15;
/** How long a request answered by code (room.send, room.read, room.members, ...) may take before the sender gives up. */
export const ROOM_REQUEST_TIMEOUT_MS =
  ROOM_REQUEST_TIMEOUT_SECONDS * MS_PER_SECOND;

const ROOM_JOIN_APPROVAL_TIMEOUT_MINUTES = 5;
/** How long a room.join (which includes a first-contact DM request) may sit awaiting a human decision before the receiving side expires it. Generous on purpose: this bounds a human approval window, not a network timeout, the same reasoning that gives a connect_request its own five minutes. */
export const ROOM_JOIN_APPROVAL_TIMEOUT_MS =
  ROOM_JOIN_APPROVAL_TIMEOUT_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND;

const APPROVAL_RESPONSE_GRACE_SECONDS = 10;
/** Extra time the requester waits beyond the receiver's approval window, so the receiver's own definitive timeout answer is normally the one the requester sees. The requester's deadline is the backstop for a receiver that never answers at all, such as one running a version without the expiry. */
export const APPROVAL_RESPONSE_GRACE_MS =
  APPROVAL_RESPONSE_GRACE_SECONDS * MS_PER_SECOND;

/** The room verb whose response is a human's accept or reject decision. */
const ROOM_JOIN_VERB = "room.join";

/** The deadline the sender should give this request. A room.join waits on a human, so it gets the receiver's approval window plus the response grace; every other request gets the short network deadline. */
export function manageRequestTimeoutMs(
  command: Readonly<ManageCommand>,
  approvalWindowMs: number,
): number {
  const waitsOnHuman = command.params.verb === ROOM_JOIN_VERB;
  return waitsOnHuman
    ? approvalWindowMs + APPROVAL_RESPONSE_GRACE_MS
    : ROOM_REQUEST_TIMEOUT_MS;
}

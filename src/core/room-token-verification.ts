/**
 * core/room's six verifier obligations (spec/room.cddl), layered on top of verifyCapabilityToken (obligations 2, 4, and 5 -- bearer match, ordinary token-claims checks, and delegations-remaining narrowing -- already live there). This module adds the checks specific to room-shaped scopes: the token must actually carry the room:member capability the six obligations presuppose (room.cddl's own obligation 1 opens with "a room:member token's delegation chain..." -- a token minted for some other capability that happens to be scoped to a room path must not pass just because scope.kind/path line up), the chain must terminate at the correct root for the path's own shape (1), and the token's own scope must actually name the room the request claims to act on (3). Obligation 6 (refuse an unrecognised content-type/kind) is a message-handling concern, not a token-verification one, and belongs to the room verb router instead.
 */

import {
  verifyCapabilityToken,
  type TokenVerdictReason,
  type VerifyCapabilityTokenOptions,
} from "wire-mesh-core/domain/tokens";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import type {
  CapabilityToken,
  DeviceId,
  TokenClaims,
} from "wire-mesh-core/generated/protocol";
import { parseRoomPath } from "./room-path.js";

/** The one capability that authorises every ordinary room-membership verb (room.send/read/leave/members) -- "one resource, not several", the same pattern exec:pty already uses for its own four inner verbs. room.join/room.invite are deliberately ungated and never reach this check at all. This same string is also the outer manage-command's own verb for every room-domain command (gated or ungated): core/room's own convention puts the specific action in params.verb, with command.verb fixed to this capability name -- exported so wire-level command construction (see wire-mesh-transport.ts/mesh-store.ts) shares this one constant rather than a second, independently-typed copy of the same literal. */
export const ROOM_MEMBER_CAPABILITY = "room:member";

export type RoomTokenVerdictReason =
  | TokenVerdictReason
  | "wrong_capability"
  | "wrong_scope_kind"
  | "wrong_scope_path"
  | "wrong_chain_root";

export type RoomTokenVerdict =
  | { ok: true; claims: TokenClaims }
  | { ok: false; reason: RoomTokenVerdictReason };

export interface VerifyRoomTokenOptions extends Omit<
  VerifyCapabilityTokenOptions,
  "expectedBearer"
> {
  /** The peer identity actually authenticated on the arriving connection (obligation 2) -- never a relay-asserted or gossip-derived value. Mandatory here: every room verb requires a bearer, unlike verifyCapabilityToken's own optional field for callers presenting a token to authorise themselves rather than a specific counterparty. */
  expectedBearer: DeviceId;
  /** The room path this request claims to act on (obligation 3) -- must equal the token's own scope.path, and its own shape determines the chain root obligation 1 requires. */
  roomPath: string;
}

/**
 * Verifies a `room:member` capability token against all six of core/room's verifier obligations. Delegates obligations 2/4/5 to verifyCapabilityToken directly; adds obligation 3 (scope.kind/scope.path must match the room being acted on) and obligation 1 (the chain's root must be the room's own owner for a named room, or the verifying identity itself for a DM -- never either named participant directly, since a DM token minted by anyone other than the verifier would let a sender self-issue authority to message a stranger unsolicited).
 */
export async function verifyRoomToken(
  token: CapabilityToken,
  options: VerifyRoomTokenOptions,
): Promise<RoomTokenVerdict> {
  const verdict = await verifyCapabilityToken(token, {
    identity: options.identity,
    clock: options.clock,
    revocation: options.revocation,
    expectedBearer: options.expectedBearer,
  });
  if (!verdict.ok) {
    return verdict;
  }

  if (verdict.claims.capability !== ROOM_MEMBER_CAPABILITY) {
    return { ok: false, reason: "wrong_capability" };
  }
  if (verdict.claims.scope.kind !== "room") {
    return { ok: false, reason: "wrong_scope_kind" };
  }
  if (verdict.claims.scope.path !== options.roomPath) {
    return { ok: false, reason: "wrong_scope_path" };
  }

  const parsed = parseRoomPath(options.roomPath);
  const expectedRootHex =
    parsed.kind === "owner-named"
      ? parsed.owner
      : deviceIdToHex(options.identity.deviceId);
  if (deviceIdToHex(verdict.rootIssuer) !== expectedRootHex) {
    return { ok: false, reason: "wrong_chain_root" };
  }

  return { ok: true, claims: verdict.claims };
}

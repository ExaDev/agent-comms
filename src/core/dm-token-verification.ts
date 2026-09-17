/**
 * Receiver-side verification of a `dm:send` capability token (agent-comms#162): the receiver-controlled admission list a user principal issues, parallel to room-token-verification.ts's own `room:member` obligations but rooted at the user principal's device-id (user-identity.ts) rather than a room's own owner -- a `dm:send` grant admits a bearer device into THIS user's communication scope across every bridge slot sharing that principal, not into one specific room path. Layered on verifyCapabilityToken the same way verifyRoomToken is: obligations 2/4/5 (bearer match, ordinary token-claims checks, delegations-remaining narrowing) live there already; this module adds the dm:send-specific obligations -- the presented token must actually carry the dm:send capability (not merely happen to share a scope shape), its scope must name this exact user principal, and its delegation chain must root at that same user principal (never at the bearer itself, or self-issued authority would let any sender simply mint its own admission).
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

/** The one capability a user principal issues to admit a device into its own DM-communication scope (agent-comms#162) -- checked receiver-side wherever an unsolicited DM contact is admitted, the way room-token-verification.ts's ROOM_MEMBER_CAPABILITY gates every ordinary room-membership verb. */
export const DM_SEND_CAPABILITY = "dm:send";

/** The scope kind a dm:send grant's own scope always carries -- the resource being granted is "communication with this user principal", named by that principal's own device-id, never a specific bridge slot's peer-id, since a dm:send grant admits a bearer into the user's whole communication scope rather than one particular device. */
export const DM_SEND_SCOPE_KIND = "user";

export type DmSendTokenVerdictReason =
  | TokenVerdictReason
  | "wrong_capability"
  | "wrong_scope_kind"
  | "wrong_scope_path"
  | "wrong_chain_root";

export type DmSendTokenVerdict =
  | { ok: true; claims: TokenClaims }
  | { ok: false; reason: DmSendTokenVerdictReason };

export interface VerifyDmSendTokenOptions extends Omit<
  VerifyCapabilityTokenOptions,
  "expectedBearer"
> {
  /** The peer identity actually authenticated on the arriving connection -- the requester presenting this token as its own authority to contact userPrincipalDeviceId, never a relay-asserted or gossip-derived value. Mandatory here, matching verifyRoomToken's own mandatory expectedBearer: every dm:send check gates a specific counterparty, unlike verifyCapabilityToken's own optional field for a caller presenting a token to authorise itself. */
  expectedBearer: DeviceId;
  /** This receiving node's own user-principal device-id (user-identity.ts's loadOrCreateUserIdentity), the only issuer a dm:send grant may validly root at. */
  userPrincipalDeviceId: DeviceId;
}

/**
 * Verifies a `dm:send` capability token against the receiver's own user-principal identity: the token must carry the dm:send capability, its scope must be kind "user" with path equal to userPrincipalDeviceId exactly, and its delegation chain must root at userPrincipalDeviceId itself -- a self-issued or third-party-issued token naming the right scope by coincidence still fails here, since rootIssuer is checked independently of scope.path.
 */
export async function verifyDmSendToken(
  token: CapabilityToken,
  options: Readonly<VerifyDmSendTokenOptions>,
): Promise<DmSendTokenVerdict> {
  const verdict = await verifyCapabilityToken(token, {
    identity: options.identity,
    clock: options.clock,
    revocation: options.revocation,
    expectedBearer: options.expectedBearer,
  });
  if (!verdict.ok) {
    return verdict;
  }

  if (verdict.claims.capability !== DM_SEND_CAPABILITY) {
    return { ok: false, reason: "wrong_capability" };
  }
  if (verdict.claims.scope.kind !== DM_SEND_SCOPE_KIND) {
    return { ok: false, reason: "wrong_scope_kind" };
  }
  const expectedPath = deviceIdToHex(options.userPrincipalDeviceId);
  if (verdict.claims.scope.path !== expectedPath) {
    return { ok: false, reason: "wrong_scope_path" };
  }
  if (deviceIdToHex(verdict.rootIssuer) !== expectedPath) {
    return { ok: false, reason: "wrong_chain_root" };
  }

  return { ok: true, claims: verdict.claims };
}

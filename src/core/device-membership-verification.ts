/**
 * Device-to-user membership (agent-comms#161): the token a bridge device holds proving the user principal (core/user-identity.ts) admitted it -- "this device speaks for me". Layered on verifyCapabilityToken exactly the way room-token-verification.ts layers core/room's own obligations on top of it: a token bearing the right capability, scoped to the right group, whose delegation chain actually roots at the claimed user principal, never merely one that happens to carry a superficially matching scope.path. Unlike a room, a device-membership token has only one acceptable chain root ever -- the user principal itself -- there is no room-style "owner-named vs DM" distinction to branch on.
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

/** The one capability a device presents to prove the user principal admitted it -- mirrors room:member's own "one resource, one verb" shape, scoped to tokens.cddl's `group` kind (a person's, team's, or organisation's own set of owned devices) rather than `room`. Registered at wire-mesh's spec/registry/core-capabilities.md as `group:member`, scope kind `group`, domain `core/management`. */
export const DEVICE_MEMBER_CAPABILITY = "group:member";

/** A user principal's own group scope path: every device-membership token's scope.path, and the group every one of the principal's admission grants roots at. Just the principal's own device-id in hex -- tokens.cddl's `group` scope kind has no identifier of its own separate from the device-id of the key the group is rooted at. */
export function userGroupPath(userDeviceId: Readonly<DeviceId>): string {
  return deviceIdToHex(userDeviceId);
}

export type DeviceMembershipVerdictReason =
  | TokenVerdictReason
  | "wrong_capability"
  | "wrong_scope_kind"
  | "wrong_scope_path"
  | "wrong_chain_root";

export type DeviceMembershipVerdict =
  | { ok: true; claims: TokenClaims; depth: number }
  | { ok: false; reason: DeviceMembershipVerdictReason };

export interface VerifyDeviceMembershipOptions extends Omit<
  VerifyCapabilityTokenOptions,
  "expectedBearer"
> {
  /** The device actually authenticated on the arriving connection (or otherwise known out of band) -- never a relay-asserted or gossip-derived value, whenever the result is used to authorise something. Mandatory here, unlike verifyCapabilityToken's own optional field for a caller presenting a token to authorise itself. The one caller that passes a gossip-derived id (directory-admission.ts, for a membership proof read off a gossiped advert) deliberately treats the result as a claim about that id and nothing more. */
  expectedBearer: DeviceId;
  /** The user principal this membership is claimed to belong to. Determines both the expected scope.path (userGroupPath) and the delegation chain's only acceptable root -- a device-membership token minted by anyone other than this principal must never verify, regardless of what its scope claims. */
  userDeviceId: DeviceId;
}

/**
 * Verifies a `group:member` capability token: the token is a well-formed, currently valid capability token (verifyCapabilityToken's own obligations -- signature, expiry, revocation, bearer match), it actually carries the `group:member` capability (a token minted for some other capability that happens to be scoped to this group path must not pass just because scope.kind/path line up), its scope is the claimed user principal's own group, and its delegation chain roots at that principal's own device-id -- never at the bearer itself or any other device, since only the user principal may admit a device to its own group.
 */
export async function verifyDeviceMembership(
  token: CapabilityToken,
  options: Readonly<VerifyDeviceMembershipOptions>,
): Promise<DeviceMembershipVerdict> {
  const verdict = await verifyCapabilityToken(token, {
    identity: options.identity,
    clock: options.clock,
    revocation: options.revocation,
    expectedBearer: options.expectedBearer,
    ...(options.extraPredicateResolvers !== undefined
      ? { extraPredicateResolvers: options.extraPredicateResolvers }
      : {}),
  });
  if (!verdict.ok) {
    return verdict;
  }

  if (verdict.claims.capability !== DEVICE_MEMBER_CAPABILITY) {
    return { ok: false, reason: "wrong_capability" };
  }
  if (verdict.claims.scope.kind !== "group") {
    return { ok: false, reason: "wrong_scope_kind" };
  }
  const expectedGroupPath = userGroupPath(options.userDeviceId);
  if (verdict.claims.scope.path !== expectedGroupPath) {
    return { ok: false, reason: "wrong_scope_path" };
  }
  if (deviceIdToHex(verdict.rootIssuer) !== expectedGroupPath) {
    return { ok: false, reason: "wrong_chain_root" };
  }

  return { ok: true, claims: verdict.claims, depth: verdict.depth };
}

/**
 * Device group membership (agent-comms#161, widened to machines by agent-comms#343): the token a bridge device holds proving a grouping issuer admitted it, either its user principal (core/user-identity.ts, "this device speaks for me") or its machine (core/machine-identity.ts, "this device runs on me"). Layered on verifyCapabilityToken exactly the way room-token-verification.ts layers core/room's own obligations on top of it: a token bearing the right capability, scoped to the right group, whose delegation chain actually roots at the claimed issuer, never merely one that happens to carry a superficially matching scope.path. Unlike a room, a group:member token has only one acceptable chain root ever, the group's issuer itself; there is no room-style "owner-named vs DM" distinction to branch on.
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

/** The one capability a device presents to prove a grouping issuer admitted it, mirroring room:member's own "one resource, one verb" shape, scoped to tokens.cddl's `group` kind (a person's, team's, or organisation's own set of owned devices) rather than `room`. Registered at wire-mesh's spec/registry/core-capabilities.md as `group:member`, scope kind `group`, domain `core/management`. */
export const DEVICE_MEMBER_CAPABILITY = "group:member";

/** A grouping issuer's own group scope path: every group:member token's scope.path, and the group every one of that issuer's admission grants roots at. The issuer is a user principal (user-identity.ts) or a machine (machine-identity.ts, agent-comms#343); either way the path is just the issuer's own device-id in hex, since tokens.cddl's `group` scope kind has no identifier of its own separate from the device-id of the key the group is rooted at. */
export function groupPath(issuerDeviceId: Readonly<DeviceId>): string {
  return deviceIdToHex(issuerDeviceId);
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

/** What identifyGroupIssuer reports: the verdict of verifyDeviceMembership, plus the issuer (hex) the token turned out to be rooted at. */
export type GroupIssuerVerdict =
  | { ok: true; issuerHex: string; claims: TokenClaims; depth: number }
  | { ok: false; reason: DeviceMembershipVerdictReason };

export interface VerifyGroupTokenOptions extends Omit<
  VerifyCapabilityTokenOptions,
  "expectedBearer"
> {
  /** The device actually authenticated on the arriving connection (or otherwise known out of band), never a relay-asserted or gossip-derived value, whenever the result is used to authorise something. Mandatory here, unlike verifyCapabilityToken's own optional field for a caller presenting a token to authorise itself. The callers that pass a gossip-derived id (directory-admission.ts and the machine grouping in list_agents, for a proof read off a gossiped advert) deliberately treat the result as a claim about that id and nothing more. */
  expectedBearer: DeviceId;
}

export interface VerifyDeviceMembershipOptions extends VerifyGroupTokenOptions {
  /** The grouping issuer (a user principal or a machine) this membership is claimed to belong to. Determines both the expected scope.path (groupPath) and the delegation chain's only acceptable root: a group:member token minted by anyone other than this issuer must never verify, regardless of what its scope claims. */
  groupIssuerId: DeviceId;
}

type GroupTokenVerdict =
  | { ok: true; claims: TokenClaims; depth: number; rootHex: string }
  | { ok: false; reason: DeviceMembershipVerdictReason };

/** The checks every group:member token passes whoever its issuer is: verifyCapabilityToken's own obligations (signature, expiry, revocation, bearer match), the group:member capability (a token minted for some other capability that happens to be scoped to a group path must not pass just because scope.kind and path line up), and a group scope. */
async function verifyGroupToken(
  token: CapabilityToken,
  options: Readonly<VerifyGroupTokenOptions>,
): Promise<GroupTokenVerdict> {
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
  return {
    ok: true,
    claims: verdict.claims,
    depth: verdict.depth,
    rootHex: deviceIdToHex(verdict.rootIssuer),
  };
}

/**
 * Verifies a `group:member` capability token against a known issuer: verifyGroupToken's checks, then that its scope is the claimed issuer's own group and its delegation chain roots at that issuer's own device-id, never at the bearer itself or any other device, since only the issuer may admit a device to its own group.
 */
export async function verifyDeviceMembership(
  token: CapabilityToken,
  options: Readonly<VerifyDeviceMembershipOptions>,
): Promise<DeviceMembershipVerdict> {
  const verdict = await verifyGroupToken(token, options);
  if (!verdict.ok) return verdict;
  const expectedGroupPath = groupPath(options.groupIssuerId);
  if (verdict.claims.scope.path !== expectedGroupPath) {
    return { ok: false, reason: "wrong_scope_path" };
  }
  if (verdict.rootHex !== expectedGroupPath) {
    return { ok: false, reason: "wrong_chain_root" };
  }
  return { ok: true, claims: verdict.claims, depth: verdict.depth };
}

/** Verifies a `group:member` token without knowing its issuer beforehand, and reports which issuer it is rooted at: verifyGroupToken's checks, then that the group it names is the one its chain roots at. Used to group devices by the machine that vouches for them, where the machine is learned from the proof rather than looked up. Anything it reports is still only what that issuer claims about the bearer. */
export async function identifyGroupIssuer(
  token: CapabilityToken,
  options: Readonly<VerifyGroupTokenOptions>,
): Promise<GroupIssuerVerdict> {
  const verdict = await verifyGroupToken(token, options);
  if (!verdict.ok) return verdict;
  if (verdict.claims.scope.path !== verdict.rootHex) {
    return { ok: false, reason: "wrong_chain_root" };
  }
  return {
    ok: true,
    issuerHex: verdict.rootHex,
    claims: verdict.claims,
    depth: verdict.depth,
  };
}

/**
 * Device-to-user membership admission and removal (agent-comms#161): mints and revokes a device's own group:member grant from the user principal, the same "ordinary mint and revoke" mechanism room-lifecycle.ts's own kickFromRoom already uses for room-membership exclusion, rooted at the principal (core/user-identity.ts) rather than a room owner. Orchestrates mintCapabilityToken/mintRevocationEntry together with the principal's own issued-grant bookkeeping (user-identity.ts) so a later removal can find the right token-id to revoke -- the same tight coupling room-lifecycle.ts's own admission methods already have with identity-store.ts's issuedGrants, just here as plain functions rather than class methods, since there is no MeshStore-equivalent orchestrator for device membership yet.
 *
 * Deliberately does not touch the admitted device's own identity-store.ts slot (its saveGroupToken/loadGroupTokens/deleteGroupToken): whether an admission happens entirely locally (the same process holding both the principal's key and the device's own slot) or needs to reach a different bridge process is a routing question this module makes no assumption about, so persisting the granted token into the recipient's own slot -- and broadcasting a removal's revocation entry to the mesh -- is left to the caller, which has that context.
 */

import {
  mintCapabilityToken,
  mintRevocationEntry,
  type MintVerdict,
} from "wire-mesh-core/domain/tokens";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import type { RevocationView } from "wire-mesh-core/domain/revocation-view";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import type { Clock } from "wire-mesh-core/ports/clock";
import type {
  DeviceId,
  RevocationEntry,
} from "wire-mesh-core/generated/protocol";
import {
  DEVICE_MEMBER_CAPABILITY,
  userGroupPath,
} from "./device-membership-verification.js";
import {
  deleteIssuedDeviceGrant,
  loadIssuedDeviceGrant,
  saveIssuedDeviceGrant,
  type UserIdentityOptions,
} from "./user-identity.js";

/** delegationsRemaining for every device-membership grant -- deliberately non-delegable: a device that could re-mint membership for another device would let any admitted device silently admit others, defeating the point of the principal being the one place admission is decided (the same reasoning room-lifecycle.ts's own mintOwnerRootGrant already documents for a room owner's self-grant). */
const NOT_DELEGABLE = 0;

export interface AdmitDeviceOptions {
  /** The user principal's own identity -- signs the membership grant. */
  userIdentity: IdentityPort;
  /** Directory override for tests, forwarded to user-identity.ts's own issued-grant storage -- must resolve to the same user-identity.json userIdentity's own key material lives in. */
  userIdentityOptions?: UserIdentityOptions;
  clock: Clock;
  tokenId: Uint8Array<ArrayBuffer>;
  /** The device being admitted. */
  deviceId: DeviceId;
  expires: number;
}

/**
 * Mints deviceId's own group:member grant from the user principal: a root-level, non-delegable token scoped to the principal's own group (userGroupPath). On success, records the grant's token-id under the principal's own issued-grant store so a later removeDevice call can find it to revoke -- an admission without this bookkeeping would leave removal permanently unable to find what to revoke, so this is not optional side-book-keeping, it is what makes revocation possible at all.
 */
export async function admitDevice(
  options: Readonly<AdmitDeviceOptions>,
): Promise<MintVerdict> {
  const verdict = await mintCapabilityToken({
    identity: options.userIdentity,
    clock: options.clock,
    tokenId: options.tokenId,
    bearer: options.deviceId,
    capability: DEVICE_MEMBER_CAPABILITY,
    scope: {
      kind: "group",
      path: userGroupPath(options.userIdentity.deviceId),
    },
    expires: options.expires,
    delegationsRemaining: NOT_DELEGABLE,
  });
  if (!verdict.ok) return verdict;

  saveIssuedDeviceGrant(
    options.userIdentityOptions,
    deviceIdToHex(options.deviceId),
    options.tokenId,
  );
  return verdict;
}

export interface RemoveDeviceOptions {
  /** The user principal's own identity -- only the principal that issued a device's membership may revoke it. */
  userIdentity: IdentityPort;
  userIdentityOptions?: UserIdentityOptions;
  clock: Clock;
  /** Recorded locally immediately, so this principal's own future verifications see the removal without waiting on gossip -- mirrors room-lifecycle.ts's own revokeMemberGrant ordering (record before broadcast). */
  revocation: RevocationView;
  deviceId: DeviceId;
}

/**
 * Revokes deviceId's own group:member grant for real, if this principal ever recorded admitting it: mints a revocation-entry for its token-id, records it in the given RevocationView immediately, and forgets the issued-grant record (a later re-admission mints and records a genuinely fresh one rather than leaving a stale entry alongside it). Silently returns undefined when no issued-grant record exists (a device that was never actually admitted, or a grant predating this bookkeeping) -- mirrors room-lifecycle.ts's own revokeMemberGrant, which does the same for a room member.
 *
 * Returns the minted entry so the caller can broadcast it to the mesh (this module has no MeshTransport dependency to do so itself, mirroring the module-level "no assumption about locality" boundary documented above) -- every other device that might hold this device's grant, including other devices of this same user, needs the entry to independently start refusing it.
 */
export async function removeDevice(
  options: Readonly<RemoveDeviceOptions>,
): Promise<RevocationEntry | undefined> {
  const deviceHex = deviceIdToHex(options.deviceId);
  const tokenId = loadIssuedDeviceGrant(options.userIdentityOptions, deviceHex);
  if (tokenId === undefined) return undefined;

  const entry = await mintRevocationEntry({
    identity: options.userIdentity,
    tokenId,
    revokedAt: options.clock.now(),
  });
  await options.revocation.record(entry, { identity: options.userIdentity });
  deleteIssuedDeviceGrant(options.userIdentityOptions, deviceHex);
  return entry;
}

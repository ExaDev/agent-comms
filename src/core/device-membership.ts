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
  groupPath,
} from "./device-membership-verification.js";
import type { AccountLedger } from "./account-ledger.js";

/** delegationsRemaining for every device-membership grant -- deliberately non-delegable: a device that could re-mint membership for another device would let any admitted device silently admit others, defeating the point of the principal being the one place admission is decided (the same reasoning room-lifecycle.ts's own mintOwnerRootGrant already documents for a room owner's self-grant). */
const NOT_DELEGABLE = 0;

export interface AdmitDeviceOptions {
  /** The user principal's own identity -- signs the membership grant. */
  userIdentity: IdentityPort;
  /** The account's replicated grant ledger, which records the admission so any machine holding the account key can revoke it. */
  accountLedger: AccountLedger;
  clock: Clock;
  tokenId: Uint8Array<ArrayBuffer>;
  /** The device being admitted. */
  deviceId: DeviceId;
  expires: number;
}

export interface MintGroupMembershipOptions {
  /** The grouping issuer signing the grant: a user principal (user-identity.ts) or a machine (machine-identity.ts). The grant is scoped to this issuer's own group (groupPath). */
  issuer: IdentityPort;
  clock: Clock;
  tokenId: Uint8Array<ArrayBuffer>;
  /** The device being admitted: the grant's bearer. */
  deviceId: DeviceId;
  expires: number;
}

/** The group:member token itself, with no record kept of having issued it: a root-level, non-delegable grant bearing options.deviceId and scoped to the issuer's own group (groupPath). admitDevice adds the issued-grant bookkeeping a later removeDevice needs; a caller that only needs a short-lived proof (membership-proof.ts) uses this directly, so the shared identity file is not rewritten every time one of its many bridges refreshes its proof. */
export async function mintGroupMembership(
  options: Readonly<MintGroupMembershipOptions>,
): Promise<MintVerdict> {
  return mintCapabilityToken({
    identity: options.issuer,
    clock: options.clock,
    tokenId: options.tokenId,
    bearer: options.deviceId,
    capability: DEVICE_MEMBER_CAPABILITY,
    scope: {
      kind: "group",
      path: groupPath(options.issuer.deviceId),
    },
    expires: options.expires,
    delegationsRemaining: NOT_DELEGABLE,
  });
}

/**
 * Mints deviceId's own group:member grant from the user principal: a root-level, non-delegable token scoped to the principal's own group (groupPath). On success, records the grant's token-id in the account's replicated ledger so a later removeDevice, on this machine or any other holding the account key, can find it to revoke. An admission without that record would leave removal permanently unable to find what to revoke, so it is what makes revocation possible at all.
 */
export async function admitDevice(
  options: Readonly<AdmitDeviceOptions>,
): Promise<MintVerdict> {
  const verdict = await mintGroupMembership({
    ...options,
    issuer: options.userIdentity,
  });
  if (!verdict.ok) return verdict;

  await options.accountLedger.recordGrant(
    "device",
    deviceIdToHex(options.deviceId),
    options.tokenId,
  );
  return verdict;
}

export interface RemoveDeviceOptions {
  /** The user principal's own identity -- only the principal that issued a device's membership may revoke it. */
  userIdentity: IdentityPort;
  accountLedger: AccountLedger;
  clock: Clock;
  /** Recorded locally immediately, so this principal's own future verifications see the removal without waiting on gossip -- mirrors room-lifecycle.ts's own revokeMemberGrant ordering (record before broadcast). */
  revocation: RevocationView;
  deviceId: DeviceId;
}

/**
 * Revokes every group:member grant for deviceId that the account's ledger holds as outstanding, whichever machine of the account minted it: mints a revocation-entry for each token-id, records it in the given RevocationView immediately, and appends it to the ledger, so every other machine of the account sees the grant as revoked and a later re-admission starts from nothing outstanding. Returns no entries for a device the account never admitted.
 *
 * Returns the minted entries so the caller can broadcast them to the mesh (this module has no MeshTransport dependency to do so itself, mirroring the module-level "no assumption about locality" boundary documented above): every other device that might hold one of this device's grants needs the entry to independently start refusing it.
 */
export async function removeDevice(
  options: Readonly<RemoveDeviceOptions>,
): Promise<RevocationEntry[]> {
  const deviceHex = deviceIdToHex(options.deviceId);
  const outstanding = await options.accountLedger.outstandingGrants(
    "device",
    deviceHex,
  );
  const entries: RevocationEntry[] = [];
  for (const { tokenId } of outstanding) {
    const entry = await mintRevocationEntry({
      identity: options.userIdentity,
      tokenId,
      revokedAt: options.clock.now(),
    });
    await options.revocation.record(entry, { identity: options.userIdentity });
    await options.accountLedger.recordRevocation(
      "device",
      deviceHex,
      tokenId,
      entry,
    );
    entries.push(entry);
  }
  return entries;
}

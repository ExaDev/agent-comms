/**
 * Sub-delegation of a received dm:send grant to one of the recipient principal's own devices (agent-comms#187): once a remote user principal has been admitted into another user's DM-communication scope (room-lifecycle.ts's admitAgentForDm, minted with delegationsRemaining \> 0 specifically to allow this), that principal mints a CHILD dm:send token -- parent = the grant it received, bearer = its own device -- so a specific device can present durable admission on the principal's behalf, without the admitting side ever needing to know that device's own device-id in advance. Mirrors device-membership.ts's admitDevice in shape (a plain mint-and-record function, no MeshStore-equivalent orchestrator), but delegates an EXISTING grant via `parent` rather than self-issuing a fresh root-level one -- the first real use of mintCapabilityToken's parent-narrowing machinery in this codebase, every grant minted before this having been an independent root-level token.
 *
 * Deliberately does not touch the delegated device's own identity-store.ts slot, mirroring device-membership.ts's own "no assumption about locality" stance: getting the minted token onto that device (this process, or a different one) is left entirely to the caller.
 */

import {
  mintCapabilityToken,
  type MintVerdict,
} from "wire-mesh-core/domain/tokens";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import type { Clock } from "wire-mesh-core/ports/clock";
import type {
  CapabilityToken,
  DeviceId,
} from "wire-mesh-core/generated/protocol";
import {
  DM_SEND_CAPABILITY,
  DM_SEND_SCOPE_KIND,
} from "./dm-token-verification.js";
import {
  saveIssuedDmGrant,
  type UserIdentityOptions,
} from "./user-identity.js";

/** delegationsRemaining a delegated device's own token permits below it, when the caller doesn't ask for more -- 0, matching every other non-delegable grant this codebase already mints by default (device-membership.ts's own NOT_DELEGABLE): an ordinary device is a leaf of the chain, not a further delegator. */
const LEAF_NOT_DELEGABLE = 0;

export interface DelegateDmSendToDeviceOptions {
  /** The principal doing the sub-delegating -- must be the same identity the parent grant's own bearer names, or mintCapabilityToken's own parent-bearer-matches-issuer narrowing check refuses the mint outright (`parent_bearer_mismatch`). */
  userIdentity: IdentityPort;
  /** Directory override for tests, forwarded to user-identity.ts's own issued-grant storage -- must resolve to the same user-identity.json userIdentity's own key material lives in. */
  userIdentityOptions?: UserIdentityOptions;
  clock: Clock;
  tokenId: Uint8Array<ArrayBuffer>;
  /** The grant this principal itself was admitted with (room-lifecycle.ts's admitAgentForDm, minted with delegationsRemaining \> 0) -- every one of tokens.cddl's own narrowing obligations is checked against it at mint time. */
  parent: CapabilityToken;
  /** The device being delegated to -- one of this principal's own devices. */
  deviceId: DeviceId;
  /** The remote user principal that originally admitted this identity -- the scope this delegated token must keep naming, unchanged from parent's own scope (tokens.cddl's own narrowing requires an identical "user" scope path down the whole chain). */
  remoteUserPrincipalDeviceId: DeviceId;
  expires: number;
  /** How many further hops the delegated token itself permits below it -- defaults to LEAF_NOT_DELEGABLE; only worth raising for a hierarchy deeper than "principal delegates directly to a device" genuinely needs. */
  delegationsRemaining?: number;
}

/**
 * Mints deviceId's own dm:send delegation from a received grant: bearer = deviceId, parent = the grant this principal itself was admitted with, scope unchanged (still the REMOTE admitting principal's own "user" scope, never this principal's own device-id) -- mintCapabilityToken's own narrowing refuses this outright if parent's own delegationsRemaining was 0 (nothing left to sub-delegate) or if userIdentity does not match parent's own bearer. On success, records the token-id under THIS principal's own issued-grant store, keyed by deviceId's hex, so a later revocation can find it -- reuses user-identity.ts's saveIssuedDmGrant/loadIssuedDmGrant/deleteIssuedDmGrant exactly as admitAgentForDm's own root-level self-grants do, since both are simply "grants this identity has issued," keyed by bearer, regardless of whether the grant is root-level or itself a delegation.
 */
export async function delegateDmSendToDevice(
  options: Readonly<DelegateDmSendToDeviceOptions>,
): Promise<MintVerdict> {
  const verdict = await mintCapabilityToken({
    identity: options.userIdentity,
    clock: options.clock,
    tokenId: options.tokenId,
    bearer: options.deviceId,
    capability: DM_SEND_CAPABILITY,
    scope: {
      kind: DM_SEND_SCOPE_KIND,
      path: deviceIdToHex(options.remoteUserPrincipalDeviceId),
    },
    expires: options.expires,
    delegationsRemaining: options.delegationsRemaining ?? LEAF_NOT_DELEGABLE,
    parent: options.parent,
  });
  if (!verdict.ok) return verdict;

  saveIssuedDmGrant(
    options.userIdentityOptions,
    deviceIdToHex(options.deviceId),
    options.tokenId,
  );
  return verdict;
}

/**
 * The proof a device gossips to show that its user principal vouches for it (agent-comms#266): a short-lived group:member token, minted by that principal for that one device, carried as one line of text. A receiver that trusts the principal verifies it against the gossiping device and then trusts the device without it being listed individually, which is what trusting a principal is for.
 *
 * Every bridge of one account shares that account's user identity, so any of them can mint a proof for any device id, which is the same trust the principal is given anyway. Proofs are short-lived rather than revocable: they are minted without recording an issued-grant, so a bridge refreshing its own does not rewrite the shared user-identity.json.
 */

import type { Clock } from "wire-mesh-core/ports/clock";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import type { RevocationView } from "wire-mesh-core/domain/revocation-view";
import type { DeviceId } from "wire-mesh-core/generated/protocol";
import { mintDeviceMembership } from "./device-membership.js";
import { verifyDeviceMembership } from "./device-membership-verification.js";
import { randomId } from "./random-id.js";
import { CommsError } from "./store.js";
import { decodeTokenText, encodeTokenText } from "./token-text.js";

const MS_PER_MINUTE = 60_000;
const MEMBERSHIP_PROOF_LIFETIME_MINUTES = 15;

/** How long a minted proof stays valid. Long enough to ride out a missed refresh or a gossip gap, short enough that a device an account stops running stops being trusted soon after. */
export const MEMBERSHIP_PROOF_LIFETIME_MS =
  MEMBERSHIP_PROOF_LIFETIME_MINUTES * MS_PER_MINUTE;

export interface MintMembershipProofOptions {
  /** The user principal vouching for the device. */
  userIdentity: IdentityPort;
  clock: Clock;
  /** The device the proof is for, and the only device it will verify for. */
  deviceId: DeviceId;
}

/** A fresh proof that options.userIdentity vouches for options.deviceId, as one line of text. Throws MINT_FAILED if the token cannot be minted. */
export async function mintMembershipProof(
  options: Readonly<MintMembershipProofOptions>,
): Promise<string> {
  const verdict = await mintDeviceMembership({
    userIdentity: options.userIdentity,
    clock: options.clock,
    tokenId: randomId(),
    deviceId: options.deviceId,
    expires: options.clock.now() + MEMBERSHIP_PROOF_LIFETIME_MS,
  });
  if (!verdict.ok) {
    throw new CommsError(
      `Failed to mint a membership proof: ${verdict.reason}`,
      "MINT_FAILED",
    );
  }
  return encodeTokenText(verdict.token);
}

export interface VerifyMembershipProofOptions {
  proof: string;
  /** The device the proof is claimed for: the gossiping device the directory entry names. */
  deviceId: DeviceId;
  /** The principal the proof must have been minted by. */
  principalId: DeviceId;
  /** The verifying node's own identity, clock and revocation view. */
  identity: IdentityPort;
  clock: Clock;
  revocation: RevocationView;
}

export type MembershipProofVerdict =
  { ok: true; expires: number } | { ok: false; reason: string };

/** Whether options.proof shows that options.principalId vouches for options.deviceId right now. Never throws for a bad proof: text that is not a token, a token for another device or principal, an expired or revoked one, all come back as a refusal. */
export async function verifyMembershipProof(
  options: Readonly<VerifyMembershipProofOptions>,
): Promise<MembershipProofVerdict> {
  let token;
  try {
    token = decodeTokenText(options.proof);
  } catch {
    return { ok: false, reason: "not_a_token" };
  }
  const verdict = await verifyDeviceMembership(token, {
    identity: options.identity,
    clock: options.clock,
    revocation: options.revocation,
    expectedBearer: options.deviceId,
    userDeviceId: options.principalId,
  });
  if (!verdict.ok) return { ok: false, reason: verdict.reason };
  return { ok: true, expires: verdict.claims.expires };
}

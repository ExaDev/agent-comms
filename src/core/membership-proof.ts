/**
 * The proof a device gossips to show that a grouping issuer vouches for it (agent-comms#266 for the user principal, agent-comms#343 for the machine): a short-lived group:member token, minted by that issuer for that one device, carried as one line of text. A receiver that trusts the issuer verifies it against the gossiping device and then trusts the device without it being listed individually, which is what trusting a principal or a machine is for. A receiver that only wants to know which machine a device runs on reads the issuer out of the proof (identifyMembershipProofIssuer).
 *
 * A proof shows that the issuer vouches for a device id. It does not show that whoever gossips it is that device: both arrive in the same unauthenticated advert and anyone who has read one can repeat it, so it earns only what GatewayTrust.isReachable grants (see directory-admission.ts). It is also public: it names the issuer, so anyone connected to the hub can see which devices belong to which principal and which run on the same machine. That is why a proof is only ever carried in the agent/self advert, which a hidden or ghost agent never sends.
 *
 * Every bridge of one account shares that account's user identity, and every bridge on one host shares that host's machine identity, so any of them can mint a proof for any device id, which is the same trust the issuer is given anyway. Proofs are short-lived rather than revocable, so removeDevice (which revokes an admitDevice grant) does not affect them and a removed device holding the issuer's key can keep minting its own: they are minted without recording an issued-grant, so a bridge refreshing its own does not rewrite the shared identity file.
 */

import type { Clock } from "wire-mesh-core/ports/clock";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import type { RevocationView } from "wire-mesh-core/domain/revocation-view";
import type {
  CapabilityToken,
  DeviceId,
} from "wire-mesh-core/generated/protocol";
import { mintGroupMembership } from "./device-membership.js";
import {
  identifyGroupIssuer,
  verifyDeviceMembership,
} from "./device-membership-verification.js";
import { randomId } from "./random-id.js";
import { CommsError } from "./store.js";
import { decodeTokenText, encodeTokenText } from "./token-text.js";

const MS_PER_MINUTE = 60_000;
const MEMBERSHIP_PROOF_LIFETIME_MINUTES = 15;

/** The longest proof text a receiver will look at. A real proof is a single root-level token, well under half of this; a longer one can only be something else, and the length also bounds how deep a delegation chain could be smuggled in. */
export const MAX_MEMBERSHIP_PROOF_LENGTH = 4096;

/** How long a minted proof stays valid. Long enough to ride out a missed refresh or a gossip gap, short enough that a device an account stops running stops being trusted soon after. */
export const MEMBERSHIP_PROOF_LIFETIME_MS =
  MEMBERSHIP_PROOF_LIFETIME_MINUTES * MS_PER_MINUTE;

export interface MintMembershipProofOptions {
  /** The grouping issuer vouching for the device: the user principal or the machine. */
  issuer: IdentityPort;
  clock: Clock;
  /** The device the proof is for, and the only device it will verify for. */
  deviceId: DeviceId;
}

/** A fresh proof that options.issuer vouches for options.deviceId, as one line of text. Throws MINT_FAILED if the token cannot be minted. */
export async function mintMembershipProof(
  options: Readonly<MintMembershipProofOptions>,
): Promise<string> {
  const verdict = await mintGroupMembership({
    issuer: options.issuer,
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
  /** The issuer (principal or machine) the proof must have been minted by. */
  issuerId: DeviceId;
  /** The verifying node's own identity, clock and revocation view. */
  identity: IdentityPort;
  clock: Clock;
  revocation: RevocationView;
}

export type MembershipProofVerdict =
  { ok: true; expires: number } | { ok: false; reason: string };

/** The proof text decoded to a token, or the refusal for text that cannot be one. */
function decodeProof(
  proof: string,
): { ok: true; token: CapabilityToken } | { ok: false; reason: string } {
  if (proof.length > MAX_MEMBERSHIP_PROOF_LENGTH) {
    return { ok: false, reason: "too_long" };
  }
  try {
    return { ok: true, token: decodeTokenText(proof) };
  } catch {
    return { ok: false, reason: "not_a_token" };
  }
}

/** Whether options.proof shows that options.issuerId vouches for options.deviceId right now. Never throws for a bad proof: text that is not a token, a token for another device or issuer, an expired or revoked one, all come back as a refusal. */
export async function verifyMembershipProof(
  options: Readonly<VerifyMembershipProofOptions>,
): Promise<MembershipProofVerdict> {
  const decoded = decodeProof(options.proof);
  if (!decoded.ok) return decoded;
  const verdict = await verifyDeviceMembership(decoded.token, {
    identity: options.identity,
    clock: options.clock,
    revocation: options.revocation,
    expectedBearer: options.deviceId,
    groupIssuerId: options.issuerId,
  });
  if (!verdict.ok) return { ok: false, reason: verdict.reason };
  // Every proof is minted at the root and cannot be delegated; a chain here would be someone else's construction.
  if (verdict.depth !== 0) return { ok: false, reason: "not_root_level" };
  return { ok: true, expires: verdict.claims.expires };
}

export type IdentifyMembershipProofOptions = Omit<
  VerifyMembershipProofOptions,
  "issuerId"
>;

export type IdentifiedMembershipProof =
  | { ok: true; issuerHex: string; expires: number }
  | { ok: false; reason: string };

/** Which issuer options.proof shows vouching for options.deviceId right now, learned from the proof itself rather than checked against one already known: the same refusals as verifyMembershipProof, plus a proof whose named group is not the key that signed it. */
export async function identifyMembershipProofIssuer(
  options: Readonly<IdentifyMembershipProofOptions>,
): Promise<IdentifiedMembershipProof> {
  const decoded = decodeProof(options.proof);
  if (!decoded.ok) return decoded;
  const verdict = await identifyGroupIssuer(decoded.token, {
    identity: options.identity,
    clock: options.clock,
    revocation: options.revocation,
    expectedBearer: options.deviceId,
  });
  if (!verdict.ok) return { ok: false, reason: verdict.reason };
  if (verdict.depth !== 0) return { ok: false, reason: "not_root_level" };
  return {
    ok: true,
    issuerHex: verdict.issuerHex,
    expires: verdict.claims.expires,
  };
}

/**
 * Which gossiped directory entries from the hub a gateway merges (agent-comms#156, widened by #187, #266 and #343). Split out of WireMeshTransport, which hands it the two collaborators it needs.
 *
 * A membership proof shows that a trusted principal or machine vouches for a device id. It does not show that whoever sent the advert is that device: the id and the proof both arrive in the same unauthenticated advert, and anyone who has read one can repeat it. So it earns only what GatewayTrust.isReachable grants (a directory entry and a route), never isTrusted, and everything a request to such a device carries is authenticated by the end-to-end session inside the relay. Verifying a proof is cryptography, so the work is bounded here: verdicts are remembered, a batch verifies only so many new proofs, and a verifier that throws refuses the entry rather than breaking the merge.
 */

import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import type { DirectoryEntry } from "wire-mesh-core/domain/mesh-session";
import type { GatewayTrustReader, GroupKind } from "./gateway-trust.js";
import {
  readMembershipProof,
  type MembershipProofField,
} from "./gossip-directory.js";
import type { WireMeshTransportOptions } from "./wire-mesh-transport-options.js";

/** How many new proofs one batch of entries may verify. Trusted devices and proofs already judged cost nothing against it, so a flood of fresh adverts costs a bounded amount of work per batch and the rest wait for the next. */
export const MAX_VERIFICATIONS_PER_BATCH = 8;

const MS_PER_SECOND = 1000;
const NEGATIVE_VERDICT_TTL_SECONDS = 60;
/** How long a refused proof is remembered before it is worth checking again: long enough that a repeated bad proof is not re-verified on every frame, short enough that a principal trusted a moment later takes effect promptly. */
export const NEGATIVE_VERDICT_TTL_MS =
  NEGATIVE_VERDICT_TTL_SECONDS * MS_PER_SECOND;

/** The most proofs whose last verdict is remembered. */
const VERDICT_CACHE_LIMIT = 1024;

/** Each advert field that can carry a proof, and the kind of issuer whose trusted set it is checked against. */
const PROOF_SOURCES: readonly {
  field: MembershipProofField;
  kind: GroupKind;
}[] = [
  { field: "membership", kind: "principal" },
  { field: "machine", kind: "machine" },
];

export interface DirectoryAdmissionDeps {
  gatewayTrust: Readonly<GatewayTrustReader>;
  /** Absent when this side cannot verify proofs, in which case a proof is never enough. */
  verifyMembership: WireMeshTransportOptions["verifyMembership"];
}

interface Verdict {
  proof: string;
  ok: boolean;
  /** When a refusal stops being remembered (epoch ms). */
  until: number;
}

/** Builds the admission check for a transport's directory merge: given a batch of entries, the ones to merge. An entry is merged if its device is trusted by id, is itself a trusted principal's own device, or carries a proof that a trusted principal or machine vouches for it; a verified device is recorded in gatewayTrust until the proof lapses or its issuer stops being trusted. A device's newer proof is verified as it arrives, which is how its trust is renewed before the old one lapses. */
export function directoryAdmission(
  deps: Readonly<DirectoryAdmissionDeps>,
): (entries: readonly DirectoryEntry[]) => Promise<DirectoryEntry[]> {
  const { gatewayTrust, verifyMembership } = deps;
  /** Keyed by kind and device, since a device can carry one proof of each kind. */
  const verdicts = new Map<string, Verdict>();

  const remember = (key: string, verdict: Readonly<Verdict>): void => {
    verdicts.delete(key);
    verdicts.set(key, verdict);
    if (verdicts.size > VERDICT_CACHE_LIMIT) {
      const oldest = verdicts.keys().next();
      if (oldest.done !== true) verdicts.delete(oldest.value);
    }
  };

  const trustedIssuers = (kind: GroupKind): string[] =>
    kind === "principal"
      ? gatewayTrust.listPrincipals()
      : gatewayTrust.listMachines();

  /** The first trusted issuer of the given kind that vouches for the proof, with the proof's expiry, or undefined. An issuer the verifier throws on (a malformed id, or no identity attached yet) is skipped, so one bad issuer never blocks the others. */
  const vouchedFor = async (
    proof: string,
    deviceHex: string,
    kind: GroupKind,
  ): Promise<{ issuer: string; expires: number } | undefined> => {
    if (verifyMembership === undefined) return undefined;
    for (const issuer of trustedIssuers(kind)) {
      try {
        const verdict = await verifyMembership({
          proof,
          deviceHex,
          issuerHex: issuer,
        });
        if (verdict.ok) return { issuer, expires: verdict.expires };
      } catch {
        continue;
      }
    }
    return undefined;
  };

  return async (entries) => {
    const admitted: DirectoryEntry[] = [];
    let budget = MAX_VERIFICATIONS_PER_BATCH;
    for (const entry of entries) {
      const deviceHex = deviceIdToHex(entry.device);
      if (
        gatewayTrust.isTrusted(deviceHex) ||
        gatewayTrust.isTrustedPrincipal(deviceHex)
      ) {
        admitted.push(entry);
        continue;
      }
      if (verifyMembership === undefined) continue;
      for (const { field, kind } of PROOF_SOURCES) {
        const proof = readMembershipProof(entry.advert, field);
        if (proof === undefined) continue;

        const key = `${kind}:${deviceHex}`;
        const known = verdicts.get(key);
        if (known?.proof === proof) {
          if (known.ok && gatewayTrust.isReachable(deviceHex)) {
            admitted.push(entry);
            break;
          }
          if (!known.ok && known.until > Date.now()) continue;
        }
        if (budget === 0) continue;
        budget -= 1;

        const vouch = await vouchedFor(proof, deviceHex, kind);
        remember(key, {
          proof,
          ok: vouch !== undefined,
          until: Date.now() + NEGATIVE_VERDICT_TTL_MS,
        });
        if (vouch !== undefined) {
          gatewayTrust.noteVerifiedMember(
            deviceHex,
            { kind, issuer: vouch.issuer },
            vouch.expires,
          );
          admitted.push(entry);
          break;
        }
      }
    }
    return admitted;
  };
}

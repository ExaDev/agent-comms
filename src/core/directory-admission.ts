/**
 * Whether a gossiped directory entry from the hub may be merged (agent-comms#156, widened by #187 and #266). Split out of WireMeshTransport, which hands it the two collaborators it needs.
 */

import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import type { DirectoryEntry } from "wire-mesh-core/domain/mesh-session";
import type { GatewayTrustReader } from "./gateway-trust.js";
import { readMembershipProof } from "./gossip-directory.js";
import type { WireMeshTransportOptions } from "./wire-mesh-transport-options.js";

export interface DirectoryAdmissionDeps {
  gatewayTrust: Readonly<GatewayTrustReader>;
  /** Absent when this side cannot verify proofs, in which case a proof is never enough. */
  verifyMembership: WireMeshTransportOptions["verifyMembership"];
}

/** Builds the admission check for a transport's directory merge: whether an entry may be merged. Its device is trusted by id or is itself a trusted principal's own device, or its advert carries a membership proof that one of the trusted principals vouches for it. A verified device is recorded in gatewayTrust, so the rest of this side's trust checks (outbound routing, relayed requests) treat it as trusted until the proof lapses or its principal stops being trusted. */
export function directoryAdmission(
  deps: Readonly<DirectoryAdmissionDeps>,
): (entry: Readonly<DirectoryEntry>) => Promise<boolean> {
  return async (entry) => admitEntry(entry, deps);
}

async function admitEntry(
  entry: Readonly<DirectoryEntry>,
  deps: Readonly<DirectoryAdmissionDeps>,
): Promise<boolean> {
  const { gatewayTrust, verifyMembership } = deps;
  const deviceHex = deviceIdToHex(entry.device);
  if (
    gatewayTrust.isTrusted(deviceHex) ||
    gatewayTrust.isTrustedPrincipal(deviceHex)
  ) {
    return true;
  }
  const proof = readMembershipProof(entry.advert);
  if (proof === undefined || verifyMembership === undefined) return false;
  for (const principalHex of gatewayTrust.listPrincipals()) {
    const verdict = await verifyMembership({ proof, deviceHex, principalHex });
    if (verdict.ok) {
      gatewayTrust.noteVerifiedMember(deviceHex, principalHex, verdict.expires);
      return true;
    }
  }
  return false;
}

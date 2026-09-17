/**
 * gossip-directory — the mesh-wide gossip-directory aggregation WireMeshTransport's own listKnownDevices reads from, plus per-event directory lookups (a specific peer's presence advert). Split out purely to keep wire-mesh-transport.ts under the repo's max-lines cap, the same reason connection-approval.ts, room-router.ts, hub-session.ts, and peer-lifecycle.ts were each split from their own owning file.
 */

import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import type { DirectoryEntry } from "wire-mesh-core/domain/mesh-session";
import type { PeerAdvert } from "wire-mesh-core/generated/protocol";
import { AgentStatus } from "./types.js";
import { PRESENCE_GOSSIP_KEY } from "./wire-mesh-transport.js";

/** Merges one session event's own directory into the mesh-wide knownDevices view (mutated in place), keeping the newer advert (by snapshot-seconds) whenever a device-id is already known from an earlier event or a different session. */
export function mergeKnownDevices(
  knownDevices: Map<string, PeerAdvert>,
  directory: readonly DirectoryEntry[],
): void {
  for (const entry of directory) {
    const deviceIdHex = deviceIdToHex(entry.device);
    const existing = knownDevices.get(deviceIdHex);
    if (
      existing === undefined ||
      entry.advert["snapshot-seconds"] >= existing["snapshot-seconds"]
    ) {
      knownDevices.set(deviceIdHex, entry.advert);
    }
  }
}

/** Reads a presence extension from one specific device's own gossiped self-advert, if this event's directory carries a fresh one for exactly that device-id -- never for any other device-id a multi-hop directory might mention, since only the session's own authenticated peer's advert is that session's business to report. Returns undefined for a missing presence/status key, or a value that isn't a recognised AgentStatus -- an advert simply not participating in this convention, not an error (the same verifier obligation peer-advert's own open extension tail is documented under). */
export function findPresenceAdvert(
  deviceIdHex: string,
  directory: readonly DirectoryEntry[],
): AgentStatus | undefined {
  const entry = directory.find(
    (candidate) => deviceIdToHex(candidate.device) === deviceIdHex,
  );
  if (entry === undefined) return undefined;
  const status: unknown = entry.advert[PRESENCE_GOSSIP_KEY];
  return AgentStatus.is(status) ? status : undefined;
}

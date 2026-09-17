/**
 * mergeKnownDevices — the mesh-wide gossip-directory aggregation WireMeshTransport's own listKnownDevices reads from. Split out purely to keep wire-mesh-transport.ts under the repo's max-lines cap, the same reason connection-approval.ts, room-router.ts, hub-session.ts, and peer-lifecycle.ts were each split from their own owning file.
 */

import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import type { DirectoryEntry } from "wire-mesh-core/domain/mesh-session";
import type { PeerAdvert } from "wire-mesh-core/generated/protocol";

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

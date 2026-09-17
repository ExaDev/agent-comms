/**
 * gossip-directory — the mesh-wide gossip-directory aggregation WireMeshTransport's own listKnownDevices reads from, plus per-event directory lookups (a specific peer's presence advert). Split out purely to keep wire-mesh-transport.ts under the repo's max-lines cap, the same reason connection-approval.ts, room-router.ts, hub-session.ts, and peer-lifecycle.ts were each split from their own owning file.
 */

import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import type {
  AcceptedMeshSession,
  DirectoryEntry,
} from "wire-mesh-core/domain/mesh-session";
import type { PeerAdvert } from "wire-mesh-core/generated/protocol";
import { AgentStatus } from "./types.js";
import {
  AGENT_SELF_GOSSIP_KEY,
  HOSTED_ROOMS_GOSSIP_KEY,
  PRESENCE_GOSSIP_KEY,
  type AgentSelfAdvert,
  type HostedRoomAdvert,
} from "./wire-mesh-transport.js";
import type { HubSession } from "./hub-session.js";

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

/** Re-sends this side's own current presence status and currently-hosted rooms, together, onto every live session's gossip self-advert -- one gossip frame per tick carrying whichever of the two sources is wired in, rather than a separate frame per fact. Split out of wire-mesh-transport.ts's own WireMeshTransport class purely to keep that file under the repo's max-lines cap, the same reason mergeKnownDevices/findPresenceAdvert above already live here rather than there. A session that fails to send (mid-disconnect, most likely -- watchForDisconnect will independently notice and clean it up) is reported via onError and skipped, not allowed to stop the tick from reaching the rest of allSessions: a periodic broadcast to N peers is N independent operations, not one atomic unit. A no-op tick (neither source wired in, or no sessions exist yet) is expected and silent. The hub's own session (agent-comms#156) is gated separately from every ordinary local-peer session in allSessions: local mesh trust is a different layer (connect_request/introduce approval already gated it before it ever joined allSessions), but the hub session is a broadcast to every connected hub peer, trusted or not, and would otherwise leak this side's own presence/hosted-rooms/self-agent advert onto the hub regardless of GatewayTrust -- forwardAdvertsToHub/pushHubCatchUp's own hasAny gate exists to prevent exactly this for OTHER local peers' adverts, and this side's own self-advert deserves the identical gate, not a bypass. */
export function readvertiseGossip(
  allSessions: ReadonlySet<AcceptedMeshSession>,
  hub: Readonly<Pick<HubSession, "ownsSession">>,
  hasAnyTrustedGateway: () => boolean,
  onError: ((error: Error) => void) | undefined,
  getCurrentPresence: (() => AgentStatus | undefined) | undefined,
  getHostedRooms: (() => readonly HostedRoomAdvert[]) | undefined,
  getSelfAgentAdvert: (() => AgentSelfAdvert | undefined) | undefined,
): void {
  const extensions: Record<string, unknown> = {};
  const status = getCurrentPresence?.();
  if (status !== undefined) extensions[PRESENCE_GOSSIP_KEY] = status;
  const hostedRooms = getHostedRooms?.();
  if (hostedRooms !== undefined)
    extensions[HOSTED_ROOMS_GOSSIP_KEY] = hostedRooms;
  const selfAgentAdvert = getSelfAgentAdvert?.();
  if (selfAgentAdvert !== undefined)
    extensions[AGENT_SELF_GOSSIP_KEY] = selfAgentAdvert;
  if (Object.keys(extensions).length === 0) return;
  for (const session of allSessions) {
    if (hub.ownsSession(session) && !hasAnyTrustedGateway()) continue;
    session.sendGossipUpdate(extensions).catch((error: unknown) => {
      onError?.(error instanceof Error ? error : new Error(String(error)));
    });
  }
}

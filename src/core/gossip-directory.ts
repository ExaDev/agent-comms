/**
 * gossip-directory — the mesh-wide gossip-directory aggregation WireMeshTransport's own listKnownDevices reads from, plus per-event directory lookups (a specific peer's presence advert). Split out purely to keep wire-mesh-transport.ts under the repo's max-lines cap, the same reason connection-approval.ts, room-router.ts, hub-session.ts, and peer-lifecycle.ts were each split from their own owning file.
 */

import type { TransportEvents } from "./transport.js";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import type {
  AcceptedMeshSession,
  DirectoryEntry,
} from "wire-mesh-core/domain/mesh-session";
import type { PeerAdvert } from "wire-mesh-core/generated/protocol";
import { AgentStatus } from "./types.js";
import { getOwnPackageVersion } from "./package-version.js";
import {
  AGENT_SELF_GOSSIP_KEY,
  HOSTED_ROOMS_GOSSIP_KEY,
  PRESENCE_GOSSIP_KEY,
  summariseAgentSelfAdvert,
  summariseHostedRooms,
  type AgentSelfAdvert,
  type HostedRoomAdvert,
} from "./gossip-extensions.js";
import {
  AGENT_COMMS_VERSION_GOSSIP_KEY,
  type AgentCommsVersionsAdvert,
} from "./peer-versions.js";
import type { HubSession } from "./hub-session.js";

/** Merges one session event's own directory into the mesh-wide knownDevices view (mutated in place), keeping the newer advert (by snapshot-seconds) whenever a device-id is already known from an earlier event or a different session. An equal snapshot replaces the held advert, unlike the relay hub, which lets an advert take a device's registration over from a different connection only when it is strictly newer: the hub is guarding a route against a replayed advert, whereas every entry here has already been verified by the session that produced it, so an equal one carries the same content and the freshest copy is the one to keep. */
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

/**
 * The mesh-wide gossip directory a transport reads (agent-comms#48): the latest advert of every device it has heard of, from its local peer sessions and from the hub, kept across disconnects so a device's last-known advert stays queryable while its session is down.
 *
 * A device heard of through a local peer session is kept for good, since the local mesh admits its peers by its own approval rather than by gateway trust. A device heard of only through the hub is kept only while the hub would still admit it (admitted, the same decision directoryAdmission makes), and that is checked on every read (agent-comms#343): withdrawing trust from a device, principal or machine, in this process or in another that shares the trust file, removes from the view every device that trust alone let in, and so does a membership proof lapsing. Nothing re-adds such a device unless the hub admits it again.
 */
export class KnownDevices {
  private readonly adverts = new Map<string, PeerAdvert>();
  private readonly heardLocally = new Set<string>();

  /** admitted answers whether the hub would still admit the device (hex) today. */
  constructor(private readonly admitted: (deviceHex: string) => boolean) {}

  /** Merges a local peer session's directory (see mergeKnownDevices). */
  mergeLocal(directory: readonly DirectoryEntry[]): void {
    mergeKnownDevices(this.adverts, directory);
    for (const entry of directory) {
      this.heardLocally.add(deviceIdToHex(entry.device));
    }
  }

  /** Merges the hub session's admitted directory (see mergeKnownDevices). */
  mergeHub(directory: readonly DirectoryEntry[]): void {
    mergeKnownDevices(this.adverts, directory);
  }

  /** The current view, keyed by device-id hex, after dropping every hub-only device the hub would no longer admit. */
  current(): ReadonlyMap<string, Readonly<PeerAdvert>> {
    for (const deviceHex of [...this.adverts.keys()]) {
      if (!this.heardLocally.has(deviceHex) && !this.admitted(deviceHex)) {
        this.adverts.delete(deviceHex);
      }
    }
    return this.adverts;
  }
}

/** Merges a hub session's own admitted directory into knownDevices and announces each device in it as reachable. Every entry the hub hands over here has already passed admitEntries, so a device named in one is both present on the hub and trusted or vouched for by this side: exactly the moment a request queued for it becomes worth retrying, and the only such moment for a device that has no local peer session of its own to connect. */
export function mergeAndAnnounceReachable(
  knownDevices: KnownDevices,
  directory: readonly DirectoryEntry[],
  events: Readonly<Pick<TransportEvents, "onDeviceReachable">>,
): void {
  knownDevices.mergeHub(directory);
  for (const entry of directory) {
    events.onDeviceReachable(deviceIdToHex(entry.device));
  }
}

/** Every device this side has ever heard gossip from, mesh-wide -- not just its own directly-connected peers -- with each one's own latest full advert (addresses, snapshot-seconds, and every open-extension field such as presence/status). The trivial array-conversion half of WireMeshTransport's own listKnownDevices, split out purely to keep that file under the repo's max-lines cap, the same reason mergeKnownDevices above already lives here rather than there. */
export function listKnownDevicesEntries(
  knownDevices: ReadonlyMap<string, Readonly<PeerAdvert>>,
): readonly { deviceId: string; advert: Readonly<PeerAdvert> }[] {
  return Array.from(knownDevices, ([deviceId, advert]) => ({
    deviceId,
    advert,
  }));
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

/** Which agent/self field carries which issuer's proof: `membership` the user principal's, `machine` the machine's. */
export type MembershipProofField = "membership" | "machine";

/** The membership proof a peer gossiped in its agent/self advert under field, or undefined when it carries none. The advert is self-asserted by whichever peer sent it, so this only reads it; nothing about the proof is believed until it is verified. */
export function readMembershipProof(
  advert: Readonly<Record<string, unknown>>,
  field: MembershipProofField,
): string | undefined {
  const self: unknown = advert[AGENT_SELF_GOSSIP_KEY];
  if (typeof self !== "object" || self === null) return undefined;
  if (field === "membership") {
    return "membership" in self && typeof self.membership === "string"
      ? self.membership
      : undefined;
  }
  return "machine" in self && typeof self.machine === "string"
    ? self.machine
    : undefined;
}

/** The machine name claim a peer gossiped in its agent/self advert (name-claim.ts), or undefined when it carries none. Only read here; nothing it says is believed until it is verified against the machine its proof names. */
export function readMachineNameClaim(
  advert: Readonly<Record<string, unknown>>,
): string | undefined {
  const self: unknown = advert[AGENT_SELF_GOSSIP_KEY];
  if (typeof self !== "object" || self === null) return undefined;
  return "machineName" in self && typeof self.machineName === "string"
    ? self.machineName
    : undefined;
}

/** The one thing gossip re-advertisement needs from a session: somewhere to send the extension bag. */
export type GossipSession = Pick<AcceptedMeshSession, "sendGossipUpdate">;

/** Which session, if any, is the hub's. */
export interface HubOwnership {
  ownsSession: (session: Readonly<GossipSession>) => boolean;
}

/** Re-sends this side's own current presence status, currently-hosted rooms, self-agent identity, and package versions, together, onto every live session's gossip self-advert -- one gossip frame per tick carrying whichever facts are actually known, rather than a separate frame per fact. Split out of wire-mesh-transport.ts's own WireMeshTransport class purely to keep that file under the repo's max-lines cap, the same reason mergeKnownDevices/findPresenceAdvert above already live here rather than there. A session that fails to send (mid-disconnect, most likely -- watchForDisconnect will independently notice and clean it up) is reported via onError and skipped, not allowed to stop the tick from reaching the rest of allSessions: a periodic broadcast to N peers is N independent operations, not one atomic unit. Unlike presence/hostedRooms/selfAgentAdvert, the versions extension is never actually absent (this side's own agent-comms package version is always known), so every tick this function is called for sends at least that one fact -- there is no "nothing to report" case left to short-circuit on. The hub's own session (agent-comms#156) is gated separately from every ordinary local-peer session in allSessions: local mesh trust is a different layer (connect_request/introduce approval already gated it before it ever joined allSessions), but the hub session is a broadcast to every connected hub peer, trusted or not, and would otherwise leak this side's own presence/hosted-rooms/self-agent/versions advert onto the hub regardless of GatewayTrust -- so this side's own advert waits on the same hasAny gate. It also waits for a visible agent (selfAgentAdvert is only ever defined for one): presence, hosted rooms and versions describe the agent and its process, so a hidden or unregistered store puts none of them on the hub, and a hidden agent is left with only the device advert every session opens with, which is what lets it be reached by device id. What the hub session does carry is reduced to what is safe to hand to strangers (presence, the agent's name, harness and membership proof, the public rooms it hosts by path and name, and the package versions): the hub relays it to every client that connects, so the working directory, process id, tags and rooms go only to peers this side is connected to directly (agent-comms#322). */
export function readvertiseGossip(options: {
  allSessions: ReadonlySet<GossipSession>;
  hub: Readonly<HubOwnership>;
  hasAnyTrustedGateway: () => boolean;
  onError: ((error: Error) => void) | undefined;
  getCurrentPresence: (() => AgentStatus | undefined) | undefined;
  getHostedRooms: (() => readonly HostedRoomAdvert[]) | undefined;
  getSelfAgentAdvert: (() => AgentSelfAdvert | undefined) | undefined;
  /** Reads this side's own currently-running cc-peer version, when this process is fronting/bridging one -- folded into the same AGENT_COMMS_VERSION_GOSSIP_KEY advert as this side's own always-known agent-comms package version (agent-comms#198). Unlike presence/hostedRooms/selfAgentAdvert, agent-comms' own version is never genuinely absent (getOwnPackageVersion() always answers), so the versions extension is built and included unconditionally whenever this function runs at all -- there is no "no version to report" case the way there is for the other three optional facts. */
  getCcPeerVersion: (() => string | undefined) | undefined;
}): void {
  const {
    allSessions,
    hub,
    hasAnyTrustedGateway,
    onError,
    getCurrentPresence,
    getHostedRooms,
    getSelfAgentAdvert,
    getCcPeerVersion,
  } = options;
  const status = getCurrentPresence?.();
  const selfAgentAdvert = getSelfAgentAdvert?.();
  const ccPeerVersion = getCcPeerVersion?.();
  const versionsAdvert: AgentCommsVersionsAdvert = {
    agentComms: getOwnPackageVersion(),
    ...(ccPeerVersion !== undefined ? { ccPeer: ccPeerVersion } : {}),
  };
  // A hub relays whatever it is given to every client that connects, so a hub session carries only what is safe for strangers: presence, the agent's summary, the public rooms it hosts (without their descriptions) and the package versions. Directly connected peers are ones this side deals with itself, and get everything.
  const hubExtensions: Record<string, unknown> = {};
  if (status !== undefined) hubExtensions[PRESENCE_GOSSIP_KEY] = status;
  if (selfAgentAdvert !== undefined)
    hubExtensions[AGENT_SELF_GOSSIP_KEY] =
      summariseAgentSelfAdvert(selfAgentAdvert);
  hubExtensions[AGENT_COMMS_VERSION_GOSSIP_KEY] = versionsAdvert;
  const hostedRooms = getHostedRooms?.();
  if (hostedRooms !== undefined)
    hubExtensions[HOSTED_ROOMS_GOSSIP_KEY] = summariseHostedRooms(hostedRooms);
  const peerExtensions: Record<string, unknown> = { ...hubExtensions };
  if (hostedRooms !== undefined)
    peerExtensions[HOSTED_ROOMS_GOSSIP_KEY] = hostedRooms;
  if (selfAgentAdvert !== undefined)
    peerExtensions[AGENT_SELF_GOSSIP_KEY] = selfAgentAdvert;
  for (const session of allSessions) {
    const viaHub = hub.ownsSession(session);
    if (viaHub && (!hasAnyTrustedGateway() || selfAgentAdvert === undefined)) {
      continue;
    }
    session
      .sendGossipUpdate(viaHub ? hubExtensions : peerExtensions)
      .catch((error: unknown) => {
        onError?.(error instanceof Error ? error : new Error(String(error)));
      });
  }
}

/** Arms readvertiseGossip's own periodic tick, or does nothing at all when neither presence, hosted-rooms, nor self-agent-identity has a source -- WireMeshTransport's own constructor logic, split out here purely to keep that file under the repo's max-lines cap, the same reason mergeKnownDevices/findPresenceAdvert/readvertiseGossip above already live here rather than there. getCcPeerVersion never gates whether the interval starts at all (unlike the other three): it is only ever wired alongside getSelfAgentAdvert in real use (bridge-mesh.ts always supplies that one), so a construction site relying on getCcPeerVersion alone to start ticking isn't a real scenario worth its own branch. Unref'd immediately, matching every other timer this transport owns, so it never keeps the process alive on its own. */
export function startGossipInterval(options: {
  allSessions: ReadonlySet<GossipSession>;
  hub: Readonly<Pick<HubSession, "ownsSession">>;
  hasAnyTrustedGateway: () => boolean;
  onError: ((error: Error) => void) | undefined;
  getCurrentPresence: (() => AgentStatus | undefined) | undefined;
  getHostedRooms: (() => readonly HostedRoomAdvert[]) | undefined;
  getSelfAgentAdvert: (() => AgentSelfAdvert | undefined) | undefined;
  getCcPeerVersion: (() => string | undefined) | undefined;
  intervalMs: number;
}): ReturnType<typeof setInterval> | undefined {
  const {
    allSessions,
    hub,
    hasAnyTrustedGateway,
    onError,
    getCurrentPresence,
    getHostedRooms,
    getSelfAgentAdvert,
    getCcPeerVersion,
    intervalMs,
  } = options;
  if (
    getCurrentPresence === undefined &&
    getHostedRooms === undefined &&
    getSelfAgentAdvert === undefined
  ) {
    return undefined;
  }
  const interval = setInterval(() => {
    readvertiseGossip({
      allSessions,
      hub,
      hasAnyTrustedGateway,
      onError,
      getCurrentPresence,
      getHostedRooms,
      getSelfAgentAdvert,
      getCcPeerVersion,
    });
  }, intervalMs);
  interval.unref();
  return interval;
}

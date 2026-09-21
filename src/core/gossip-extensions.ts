/**
 * The domain-qualified gossip extension keys this package reads and writes on a peer's own gossiped advert, and the gossip-safe shapes two of them carry -- split out of wire-mesh-transport.ts (which writes them) so gossip-directory.ts, agent-registry.ts, room-lifecycle.ts, mesh-store.ts and hub-forwarding.ts (which read or merge them) no longer import their own vocabulary from the transport that depends on them, and to keep that file under the repo's max-lines cap. Also the shared home for the re-advertise cadence itself and the staleness window agent-registry.ts derives from it (agent-comms#301): both sides of "how fresh must a gossiped fact be to trust it" belong together, not split across the file that writes the cadence and the file that judges freshness against it.
 */

const MS_PER_SECOND = 1000;

/** How often a live device re-sends its own self-advert (WireMeshTransport's own presence-readvertisement timer) -- the producer half of agent-comms#301's own liveness signal. Chosen generously enough to avoid chattiness on an idle mesh while still keeping a remote peer's own picture of this device fresh well within the tens-of-minutes staleness window a status change is actually meaningful over. */
const PRESENCE_READVERTISE_INTERVAL_SECONDS = 20;
export const PRESENCE_READVERTISE_INTERVAL_MS =
  PRESENCE_READVERTISE_INTERVAL_SECONDS * MS_PER_SECOND;

/** Missed re-advertise ticks tolerated before a gossip-discovered device (one this side has never held a live session with, only ever heard about through the hub's directory) is presumed offline rather than trusted at whatever presence value its own last-heard advert happened to carry. 3 is the conventional "missed heartbeats" threshold distributed liveness checks converge on (enough to absorb one dropped gossip tick and one slow one without a false positive, not so many that a genuinely departed device is still reported reachable for minutes). There is no push notice of a device's own departure to react to instead (wire-mesh#230 covers the relay-pairing half of that; the hub's directory carries no equivalent for a lost connection) -- see agent-registry.ts's own listDiscoverableAgents for where this is applied. */
const PRESENCE_STALE_MISSED_TICKS = 3;
/** Default staleness window agent-comms#301's own check uses: agent-registry.ts's caller may override it (MeshStoreOptions.presenceStaleAfterMs), but every real construction site gets this unless it deliberately asks for something else. */
export const DEFAULT_PRESENCE_STALE_AFTER_MS =
  PRESENCE_READVERTISE_INTERVAL_MS * PRESENCE_STALE_MISSED_TICKS;

/** The domain-qualified gossip extension key this transport reads/writes presence under, per wire-mesh's own gossip-extension-namespacing convention (spec/CONVENTIONS.md): `<domain>/<field>`, never a bare name a second application's own extension could collide with. */
export const PRESENCE_GOSSIP_KEY = "presence/status";

/** The domain-qualified gossip extension key this transport writes this side's own currently-hosted public/private rooms under -- the write half of P3.8's room-discovery replacement for createRoom's own broadcastPatch (agent-comms#48). Same namespacing convention as PRESENCE_GOSSIP_KEY. */
export const HOSTED_ROOMS_GOSSIP_KEY = "room/hosted";

/** The lightweight, gossip-safe shape a room advertises itself under: enough for a peer to display "this device hosts a discoverable room here" without exposing anything membership- or grant-related. Deliberately excludes secret rooms (never worth advertising at all) and every CRDT membership field a real Room carries -- a gossip-discovered entry is a hint pointing at a room to join, not a substitute for the real Room object join/admission still produces. */
export interface HostedRoomAdvert {
  path: string;
  name: string;
  type: "public" | "private";
  description: string;
}

/** The domain-qualified gossip extension key this transport writes this side's own agent identity facts under -- the write half of P3.8's eventual agent register/update/offline retirement (agent-comms#48). Same namespacing convention as PRESENCE_GOSSIP_KEY/HOSTED_ROOMS_GOSSIP_KEY. */
export const AGENT_SELF_GOSSIP_KEY = "agent/self";

/** The lightweight, gossip-safe shape an agent advertises itself under: enough for a peer with no prior local record of this device to construct a real AgentIdentity-shaped discovery entry. Deliberately excludes status (already carried separately under presence/status, no need to duplicate it here) and visibility (this field is only ever populated for a "visible" agent in the first place -- see MeshStore's own selfAgentAdvert getter -- so a discovered entry's visibility is always exactly "visible" by construction, never something this advert needs to assert itself). */
export interface AgentSelfAdvert {
  name: string;
  harness: string;
  cwd: string;
  pid: number;
  startedAt: string;
  tags: string[];
  subscribedRooms: string[];
  /** A proof that this device's user principal vouches for it (membership-proof.ts), so a peer that trusts that principal trusts this device without it being listed individually. Absent until the first proof has been minted. */
  membership?: string;
}

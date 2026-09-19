/**
 * The domain-qualified gossip extension keys this package reads and writes on a peer's own gossiped advert, and the gossip-safe shapes two of them carry -- split out of wire-mesh-transport.ts (which writes them) so gossip-directory.ts, agent-registry.ts, room-lifecycle.ts, mesh-store.ts and hub-forwarding.ts (which read or merge them) no longer import their own vocabulary from the transport that depends on them, and to keep that file under the repo's max-lines cap.
 */

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
}

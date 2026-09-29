// The adverts an agent puts on gossip about itself and the rooms it hosts, built from its records. Kept apart from MeshStore so what each may carry sits in one small place: the fuller adverts go to peers on a private link, which are trusted with where the agent runs, and the card and public rooms go to a public hub, which hands every advert to every client and cannot trim one.

import type {
  AgentCardAdvert,
  AgentSelfAdvert,
  HostedRoomAdvert,
  PublicRoomAdvert,
} from "./gossip-extensions.js";
import type { AgentIdentity, Room } from "./types.js";

/** Both adverts are only ever built for an agent that has chosen to be seen. A hidden or ghost agent, or none, advertises nothing. */
function isVisible(
  agent: Readonly<AgentIdentity> | undefined,
): agent is AgentIdentity {
  return agent?.visibility === "visible";
}

export function buildSelfAgentAdvert(
  agent: Readonly<AgentIdentity> | undefined,
  membership: Readonly<Pick<AgentSelfAdvert, "membership">>,
): AgentSelfAdvert | undefined {
  if (!isVisible(agent)) return undefined;
  return {
    name: agent.name,
    harness: agent.harness,
    cwd: agent.cwd,
    pid: agent.pid,
    startedAt: agent.startedAt,
    tags: agent.tags,
    subscribedRooms: agent.subscribedRooms,
    ...membership,
  };
}

/** The card carries who the agent is and the proof its device is vouched for, and deliberately nothing about where or how it runs: no working directory, process id, joined rooms, start time or tags. */
export function buildSelfAgentCard(
  agent: Readonly<AgentIdentity> | undefined,
  membership: Readonly<Pick<AgentCardAdvert, "membership">>,
): AgentCardAdvert | undefined {
  if (!isVisible(agent)) return undefined;
  return {
    name: agent.name,
    harness: agent.harness,
    ...membership,
  };
}

/**
 * The public and private rooms a device hosts, in the shape peers on a private link are told (HOSTED_ROOMS_GOSSIP_KEY). Secret rooms are never included, since they are not worth advertising at all, and a room the device has merely replicated rather than owns is excluded too: "hosted" means this device is the one a joiner should actually reach, which only the owner is.
 */
export function buildHostedRooms(
  rooms: Readonly<Iterable<Readonly<Room>>>,
  ownerId: string,
): HostedRoomAdvert[] {
  const result: HostedRoomAdvert[] = [];
  for (const room of rooms) {
    if (room.owner !== ownerId) continue;
    if (room.type !== "public" && room.type !== "private") continue;
    result.push({
      path: room.id,
      name: room.name,
      type: room.type,
      description: room.description,
    });
  }
  return result;
}

/** The public rooms among those hosted, as a public hub is told about them: where to find each and what it is called, with no description (a project room's names a working directory) and no private room at all. */
export function buildPublicRooms(
  hosted: readonly HostedRoomAdvert[],
): PublicRoomAdvert[] {
  return hosted
    .filter((room) => room.type === "public")
    .map(({ path, name }) => ({ path, name }));
}

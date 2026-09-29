/**
 * Reads the rooms other devices advertise as hosted from the transport's gossip aggregation -- the one source of room discovery that list_rooms and bare-name room resolution (room-lookup.ts) both need to agree on.
 */

import {
  HOSTED_ROOMS_GOSSIP_KEY,
  PUBLIC_ROOMS_GOSSIP_KEY,
} from "./gossip-extensions.js";
import type {
  HostedRoomAdvert,
  PublicRoomAdvert,
} from "./gossip-extensions.js";
import type { MeshTransport } from "./transport.js";

/** A hosted room together with the device that advertised it. */
export type DiscoveredRoom = HostedRoomAdvert & { ownerDeviceId: string };

/** Narrows an untrusted gossiped value (a peer's own self-asserted `room/hosted` entry) into a HostedRoomAdvert. A malformed or non-conforming entry is skipped by the caller rather than treated as an error: this is a discovery hint over self-asserted data, not a security check. */
export function isHostedRoomAdvert(value: unknown): value is HostedRoomAdvert {
  if (typeof value !== "object" || value === null) return false;
  if (!("path" in value) || typeof value.path !== "string") return false;
  if (!("name" in value) || typeof value.name !== "string") return false;
  if (
    !("type" in value) ||
    (value.type !== "public" && value.type !== "private")
  )
    return false;
  if (!("description" in value) || typeof value.description !== "string")
    return false;
  return true;
}

/** Narrows an untrusted gossiped value (a peer's own `room/public` entry, the advert a device sends a public hub) into a PublicRoomAdvert. */
function isPublicRoomAdvert(value: unknown): value is PublicRoomAdvert {
  if (typeof value !== "object" || value === null) return false;
  if (!("path" in value) || typeof value.path !== "string") return false;
  if (!("name" in value) || typeof value.name !== "string") return false;
  return true;
}

/**
 * Every public/private room another device has gossiped as hosted, each tagged with the advertising device. A device on a private link tells us the full advert (`room/hosted`); one that reached us through a hub tells us only the path and name of its public rooms (`room/public`), and a room heard that way has an empty description because none was sent. Empty for a transport with no `listKnownDevices` capability (WireMeshTransport is the only implementation that has one). Secret rooms are never advertised at all.
 */
export function listDiscoveredRooms(
  transport: Readonly<Pick<MeshTransport, "listKnownDevices">>,
): readonly DiscoveredRoom[] {
  if (transport.listKnownDevices === undefined) return [];
  const result: DiscoveredRoom[] = [];
  for (const { deviceId, advert } of transport.listKnownDevices()) {
    const hosted = advert[HOSTED_ROOMS_GOSSIP_KEY];
    if (Array.isArray(hosted)) {
      for (const candidate of hosted) {
        if (!isHostedRoomAdvert(candidate)) continue;
        result.push({ ...candidate, ownerDeviceId: deviceId });
      }
      continue;
    }
    const publicRooms = advert[PUBLIC_ROOMS_GOSSIP_KEY];
    if (!Array.isArray(publicRooms)) continue;
    for (const candidate of publicRooms) {
      if (!isPublicRoomAdvert(candidate)) continue;
      result.push({
        path: candidate.path,
        name: candidate.name,
        type: "public",
        description: "",
        ownerDeviceId: deviceId,
      });
    }
  }
  return result;
}

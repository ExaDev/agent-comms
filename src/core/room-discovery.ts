/**
 * Reads the rooms other devices advertise as hosted from the transport's gossip aggregation -- the one source of room discovery that list_rooms and bare-name room resolution (room-lookup.ts) both need to agree on.
 */

import { HOSTED_ROOMS_GOSSIP_KEY } from "./gossip-extensions.js";
import type { HostedRoomAdvert } from "./gossip-extensions.js";
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

/**
 * Every public/private room another device has gossiped as hosted, each tagged with the advertising device. Empty for a transport with no `listKnownDevices` capability (WireMeshTransport is the only implementation that has one). Secret rooms never appear: HostedRoomAdvert's own type field excludes them at the source, so a secret room is never gossiped under this key at all.
 */
export function listDiscoveredRooms(
  transport: Readonly<MeshTransport>,
): readonly DiscoveredRoom[] {
  if (transport.listKnownDevices === undefined) return [];
  const result: DiscoveredRoom[] = [];
  for (const { deviceId, advert } of transport.listKnownDevices()) {
    const hosted = advert[HOSTED_ROOMS_GOSSIP_KEY];
    if (!Array.isArray(hosted)) continue;
    for (const candidate of hosted) {
      if (!isHostedRoomAdvert(candidate)) continue;
      result.push({ ...candidate, ownerDeviceId: deviceId });
    }
  }
  return result;
}

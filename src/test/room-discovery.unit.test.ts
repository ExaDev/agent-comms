import { describe, expect, it } from "vitest";
import { listDiscoveredRooms } from "../core/room-discovery.js";
import type { MeshTransport } from "../core/transport.js";

/** The one capability listDiscoveredRooms reads from a transport, fed a fixed directory. */
function transportKnowing(
  devices: readonly { deviceId: string; advert: Record<string, unknown> }[],
): Pick<MeshTransport, "listKnownDevices"> {
  return { listKnownDevices: () => devices };
}

describe("listDiscoveredRooms", () => {
  it("reads the full advert a device on a private link sent", () => {
    const rooms = listDiscoveredRooms(
      transportKnowing([
        {
          deviceId: "lan",
          advert: {
            "room/hosted": [
              { path: "lan/a", name: "a", type: "private", description: "d" },
            ],
          },
        },
      ]),
    );

    expect(rooms).toEqual([
      {
        path: "lan/a",
        name: "a",
        type: "private",
        description: "d",
        ownerDeviceId: "lan",
      },
    ]);
  });

  it("reads the public rooms a device sent through a hub, as public rooms with no description", () => {
    const rooms = listDiscoveredRooms(
      transportKnowing([
        {
          deviceId: "hub",
          advert: { "room/public": [{ path: "hub/b", name: "b" }] },
        },
      ]),
    );

    expect(rooms).toEqual([
      {
        path: "hub/b",
        name: "b",
        type: "public",
        description: "",
        ownerDeviceId: "hub",
      },
    ]);
  });

  it("skips a malformed public room and one that is not a list", () => {
    const rooms = listDiscoveredRooms(
      transportKnowing([
        { deviceId: "x", advert: { "room/public": [{ path: "only-path" }] } },
        { deviceId: "y", advert: { "room/public": "not a list" } },
      ]),
    );

    expect(rooms).toEqual([]);
  });

  it("prefers the full advert over the public one when a device sent both, without listing a room twice", () => {
    const rooms = listDiscoveredRooms(
      transportKnowing([
        {
          deviceId: "both",
          advert: {
            "room/hosted": [
              { path: "both/a", name: "a", type: "public", description: "d" },
            ],
            "room/public": [{ path: "both/a", name: "a" }],
          },
        },
      ]),
    );

    expect(rooms).toHaveLength(1);
    expect(rooms[0]?.description).toBe("d");
  });
});

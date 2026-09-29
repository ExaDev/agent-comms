import { describe, expect, it } from "vitest";
import { isHostedRoomAdvert } from "../core/room-discovery.js";

describe("isHostedRoomAdvert", () => {
  it("accepts a room advertised with its description", () => {
    expect(
      isHostedRoomAdvert({
        path: "owner/room",
        name: "room",
        type: "public",
        description: "d",
      }),
    ).toBe(true);
  });

  it("accepts a room advertised without one, as a hub receives it", () => {
    expect(
      isHostedRoomAdvert({ path: "owner/room", name: "room", type: "public" }),
    ).toBe(true);
  });

  it("refuses a description that is not a string", () => {
    expect(
      isHostedRoomAdvert({
        path: "owner/room",
        name: "room",
        type: "public",
        description: 1,
      }),
    ).toBe(false);
  });

  it("refuses an advert missing its path, name or a known type", () => {
    expect(isHostedRoomAdvert({ name: "room", type: "public" })).toBe(false);
    expect(isHostedRoomAdvert({ path: "p", type: "public" })).toBe(false);
    expect(isHostedRoomAdvert({ path: "p", name: "n", type: "secret" })).toBe(
      false,
    );
  });
});

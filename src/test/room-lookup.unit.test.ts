/**
 * Unit tests for resolveRoomId, the one place a caller-supplied room id or plain room name is turned into a real room id. The candidates it resolves against are whatever the caller knows of, replicated or merely discovered through gossip (agent-comms#246), so these tests drive it with bare `{ id, name }` refs.
 */
import { describe, expect, it } from "vitest";
import { resolveRoomId } from "../core/room-lookup.js";
import { CommsError } from "../core/store.js";

/** A device-id is a 64-character lowercase hex SHA-256 digest. */
const DEVICE_ID_HEX_LENGTH = 64;
const HOST_A = "a".repeat(DEVICE_ID_HEX_LENGTH);
const HOST_B = "b".repeat(DEVICE_ID_HEX_LENGTH);

describe("resolveRoomId", () => {
  it("returns an id that already names a known room unchanged", () => {
    const id = `${HOST_A}/general`;
    expect(resolveRoomId([{ id, name: "general" }], id)).toBe(id);
  });

  it("resolves a bare name to the id of the single room carrying it", () => {
    const id = `${HOST_A}/e2e-test`;
    expect(
      resolveRoomId(
        [
          { id, name: "e2e-test" },
          { id: `${HOST_A}/other`, name: "other" },
        ],
        "e2e-test",
      ),
    ).toBe(id);
  });

  it("returns a string matching no known room unchanged, leaving not-found handling to the caller", () => {
    expect(
      resolveRoomId([{ id: `${HOST_A}/general`, name: "general" }], "unknown"),
    ).toBe("unknown");
    expect(resolveRoomId([], "unknown")).toBe("unknown");
  });

  it("counts the same room supplied twice as one candidate", () => {
    const id = `${HOST_A}/general`;
    expect(
      resolveRoomId(
        [
          { id, name: "general" },
          { id, name: "general" },
        ],
        "general",
      ),
    ).toBe(id);
  });

  it("throws AMBIGUOUS_ROOM_NAME listing every candidate id when distinct rooms share the name", () => {
    const first = `${HOST_A}/general`;
    const second = `${HOST_B}/general`;
    let thrown: unknown;
    try {
      resolveRoomId(
        [
          { id: first, name: "general" },
          { id: second, name: "general" },
        ],
        "general",
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CommsError);
    expect(thrown).toMatchObject({ code: "AMBIGUOUS_ROOM_NAME" });
    expect(thrown).toHaveProperty(
      "message",
      expect.stringContaining(`${first}, ${second}`),
    );
  });

  it("prefers an exact id match over a name match on another room", () => {
    const id = `${HOST_A}/general`;
    expect(
      resolveRoomId(
        [
          { id, name: "general" },
          { id: `${HOST_B}/x`, name: id },
        ],
        id,
      ),
    ).toBe(id);
  });
});

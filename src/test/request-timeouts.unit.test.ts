/**
 * Unit tests for the manage-request deadline policy: requests that wait on a human get the approval window (plus a grace so the receiver's own answer wins), everything else gets the short network deadline.
 */
import { describe, expect, it } from "vitest";
import {
  APPROVAL_RESPONSE_GRACE_MS,
  ROOM_JOIN_APPROVAL_TIMEOUT_MS,
  ROOM_REQUEST_TIMEOUT_MS,
  manageRequestTimeoutMs,
} from "../core/request-timeouts.js";

const APPROVAL_WINDOW_MS = 4000;

describe("manageRequestTimeoutMs", () => {
  it("gives a room.join the approval window plus the response grace, since a human decides it", () => {
    expect(
      manageRequestTimeoutMs(
        { verb: "room:member", params: { verb: "room.join" } },
        APPROVAL_WINDOW_MS,
      ),
    ).toBe(APPROVAL_WINDOW_MS + APPROVAL_RESPONSE_GRACE_MS);
  });

  it("gives every other room request the short network deadline", () => {
    for (const verb of [
      "room.send",
      "room.read",
      "room.members",
      "room.leave",
    ]) {
      expect(
        manageRequestTimeoutMs(
          { verb: "room:member", params: { verb } },
          APPROVAL_WINDOW_MS,
        ),
      ).toBe(ROOM_REQUEST_TIMEOUT_MS);
    }
  });

  it("gives a command with no params the short network deadline", () => {
    expect(
      manageRequestTimeoutMs(
        { verb: "version:get", params: {} },
        APPROVAL_WINDOW_MS,
      ),
    ).toBe(ROOM_REQUEST_TIMEOUT_MS);
  });

  it("keeps the approval window well above the network deadline at its default, so a human has real time to answer", () => {
    expect(ROOM_JOIN_APPROVAL_TIMEOUT_MS).toBeGreaterThan(
      ROOM_REQUEST_TIMEOUT_MS,
    );
  });
});

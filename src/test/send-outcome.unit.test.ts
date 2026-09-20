/**
 * Unit tests for send-outcome's classification of a wire manage-outcome. The distinction under test is the one the whole honest-delivery-reporting change rests on: a failure a retry could fix versus one it never will, with an unrecognised code deliberately falling on the refusal side so it reaches its sender rather than being queued to fail again unseen.
 */
import { describe, expect, it } from "vitest";
import type { ManageOutcome } from "wire-mesh-core/domain/mesh-session";
import {
  classifyManageOutcome,
  describeRefusal,
} from "../core/send-outcome.js";

describe("classifyManageOutcome", () => {
  it("classifies an ok outcome as delivered", () => {
    expect(classifyManageOutcome({ result: "ok" })).toEqual({
      kind: "delivered",
    });
  });

  it("classifies a timeout as undelivered, the state a retry can still fix", () => {
    expect(classifyManageOutcome({ result: "error", code: "timeout" })).toEqual(
      { kind: "undelivered", reason: "timeout" },
    );
  });

  it("classifies not_connected as undelivered", () => {
    expect(
      classifyManageOutcome({ result: "error", code: "not_connected" }),
    ).toEqual({ kind: "undelivered", reason: "not_connected" });
  });

  it.each(["unauthorized", "denied", "malformed_params", "not_participant"])(
    "classifies %s as a refusal a retry cannot fix",
    (code) => {
      expect(classifyManageOutcome({ result: "error", code })).toEqual({
        kind: "refused",
        code,
      });
    },
  );

  it("carries the refuser's own message when it sent one", () => {
    const outcome: ManageOutcome = {
      result: "error",
      code: "denied",
      message: "not right now",
    };
    expect(classifyManageOutcome(outcome)).toEqual({
      kind: "refused",
      code: "denied",
      message: "not right now",
    });
  });

  it("treats a code it does not recognise as a refusal rather than queueing it", () => {
    expect(
      classifyManageOutcome({ result: "error", code: "some_future_code" }),
    ).toEqual({ kind: "refused", code: "some_future_code" });
  });
});

describe("describeRefusal", () => {
  it("renders a bare code on its own", () => {
    expect(describeRefusal({ code: "unauthorized" })).toBe("unauthorized");
  });

  it("appends the refuser's message when there is one", () => {
    expect(describeRefusal({ code: "denied", message: "busy" })).toBe(
      "denied: busy",
    );
  });
});

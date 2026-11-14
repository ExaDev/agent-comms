import { describe, expect, it } from "vitest";
import { buildAction, InvalidToolParamsError } from "../bridge.js";

function failure(params: Record<string, unknown>): unknown {
  try {
    buildAction(params);
  } catch (error) {
    return error;
  }

  return undefined;
}

// That a parameter set that validates builds its action is held by conformance/function/build-action.json.
describe("buildAction refuses parameters that fail validation", () => {
  it("names an unknown action and where it is, instead of turning the call into whoami", () => {
    const error = failure({ action: "no_such_action" });
    expect(error).toBeInstanceOf(InvalidToolParamsError);
    expect((error as InvalidToolParamsError).issues.map((i) => i.path)).toEqual(
      [["action"]],
    );
    expect((error as InvalidToolParamsError).message).toContain("action");
  });

  it("names a parameter of the wrong type", () => {
    const error = failure({ action: "mesh_listen", host: "h", port: "7" });
    expect(error).toBeInstanceOf(InvalidToolParamsError);
    expect((error as InvalidToolParamsError).issues.map((i) => i.path)).toEqual(
      [["port"]],
    );
  });
});

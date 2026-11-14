import { describe, it, expect } from "vitest";
import { MCP_TOOL_PARAMS } from "../core/bridge.js";
import { CommsActionSchema } from "../core/types.js";

/** The `action` discriminator of every arm CommsTool handles. */
const handledActions = CommsActionSchema.options.map(
  (arm) => arm.shape.action.value,
);

// That lan_web_uis validates and builds is held by conformance/validate/tool-params.json and conformance/function/build-action.json.
describe("the MCP tool's action enum", () => {
  it("lists exactly the actions CommsTool handles", () => {
    expect([...MCP_TOOL_PARAMS.shape.action.options].sort()).toEqual(
      [...handledActions].sort(),
    );
  });
});

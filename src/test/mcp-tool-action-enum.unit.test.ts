import { describe, it, expect } from "vitest";
import { buildAction, MCP_TOOL_PARAMS } from "../core/bridge.js";
import { CommsActionSchema } from "../core/types.js";

/** The `action` discriminator of every arm CommsTool handles. */
const handledActions = CommsActionSchema.options.map(
  (arm) => arm.shape.action.value,
);

describe("the MCP tool's action enum", () => {
  it("lists exactly the actions CommsTool handles", () => {
    expect([...MCP_TOOL_PARAMS.shape.action.options].sort()).toEqual(
      [...handledActions].sort(),
    );
  });

  it("accepts lan_web_uis, so an MCP client can call it", () => {
    expect(MCP_TOOL_PARAMS.safeParse({ action: "lan_web_uis" }).success).toBe(
      true,
    );
  });

  it("builds lan_web_uis into its own action instead of falling back to whoami", () => {
    expect(buildAction({ action: "lan_web_uis" })).toEqual({
      action: "lan_web_uis",
    });
  });
});

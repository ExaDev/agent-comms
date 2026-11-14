/**
 * What an agent is told about connection codes says that an unsigned one is a bearer hint, not authentication, that the tool refuses one, and what a person runs instead.
 */
import { describe, expect, test } from "vitest";
import { MCP_TOOL_PARAMS } from "../core/bridge.js";

describe("what an agent is told about an unsigned connection code", () => {
  test("the parameters the tool shows say that an unsigned code is refused and authenticates nothing", () => {
    const { shape } = MCP_TOOL_PARAMS;
    for (const field of [shape.code, shape.publicKey, shape.fingerprint]) {
      expect(field.description).toBeDefined();
    }
    expect(shape.code.description).toContain("bearer hint, not authentication");
    expect(shape.fingerprint.description).toContain("unsigned code refused");
    expect(shape.code.description).toContain("agent-comms gateway redeem");
  });
});

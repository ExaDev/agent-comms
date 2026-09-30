import { describe, expect, it } from "vitest";
import { isServedByBridge } from "../served-by-bridge.js";

describe("isServedByBridge", () => {
  it.each([
    ["localhost:19877", "http:"],
    ["127.0.0.1:4000", "http:"],
    ["127.0.0.1:4000", "https:"],
    ["192.168.1.10:4000", "http:"],
    ["studio.local:4000", "http:"],
  ])("treats %s over %s as served by a bridge", (host, protocol) => {
    expect(isServedByBridge({ host, protocol })).toBe(true);
  });

  it.each([
    ["exadev.github.io", "https:"],
    ["mesh.exadev.io", "https:"],
  ])("treats %s over %s as a standalone deployment", (host, protocol) => {
    expect(isServedByBridge({ host, protocol })).toBe(false);
  });
});

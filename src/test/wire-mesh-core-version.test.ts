/**
 * getWireMeshCoreVersion reads this process's own installed wire-mesh-core dependency's real package.json version (agent-comms#198) -- asserted here against a real semver-shaped string rather than a specific value, since the exact installed version is whatever the lockfile currently pins and would make this test rot the moment it's bumped.
 */

import { describe, it, expect } from "vitest";
import { getWireMeshCoreVersion } from "../core/wire-mesh-core-version.js";

describe("getWireMeshCoreVersion", () => {
  it("returns a semver-shaped version string", () => {
    expect(getWireMeshCoreVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("returns the identical, cached value on a second call", () => {
    expect(getWireMeshCoreVersion()).toBe(getWireMeshCoreVersion());
  });
});

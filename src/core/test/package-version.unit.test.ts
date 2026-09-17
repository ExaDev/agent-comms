/**
 * Unit tests for package-version.ts — getOwnPackageVersion.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { getOwnPackageVersion } from "../package-version.js";

function isVersionedPackageJson(
  value: unknown,
): value is { version: string } {
  if (typeof value !== "object" || value === null) return false;
  if (!("version" in value)) return false;
  return typeof value.version === "string";
}

describe("getOwnPackageVersion", () => {
  it("returns the version declared in the package's own package.json", () => {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const packageJsonPath = path.join(
      moduleDir,
      "..",
      "..",
      "..",
      "package.json",
    );
    const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
    if (!isVersionedPackageJson(parsed)) {
      throw new Error("test fixture package.json has no version string");
    }
    expect(getOwnPackageVersion()).toBe(parsed.version);
  });

  it("returns the same cached value on repeated calls", () => {
    expect(getOwnPackageVersion()).toBe(getOwnPackageVersion());
  });
});

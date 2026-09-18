/**
 * This package's own version, read once from its own package.json and cached -- the single source of truth whoami/update output (see tool.ts) and the npm version-drift check (see version-check.ts) both read from, rather than each independently locating and parsing the file.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** Narrows a parsed package.json into the shape every caller here needs -- shared by getOwnPackageVersion and wire-mesh-core-version.ts's getWireMeshCoreVersion, which reads a dependency's installed package.json the identical way. */
export function isVersionedPackageJson(
  value: unknown,
): value is { version: string } {
  if (typeof value !== "object" || value === null) return false;
  if (!("version" in value)) return false;
  return typeof value.version === "string";
}

let cachedVersion: string | undefined;

/** This package's own version, read from the package.json two directories up from this file -- tsconfig's rootDir/outDir mirror src/dist at the same depth, so the relative path resolves identically whether this runs from source or from the compiled dist output. Cached after the first successful read. */
export function getOwnPackageVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;
  const packageJsonPath = path.join(moduleDir, "..", "..", "package.json");
  const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
  if (!isVersionedPackageJson(parsed)) {
    throw new Error(
      `package.json at ${packageJsonPath} has no "version" string`,
    );
  }
  cachedVersion = parsed.version;
  return cachedVersion;
}

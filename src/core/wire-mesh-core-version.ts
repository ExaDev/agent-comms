/**
 * This process's own installed wire-mesh-core dependency version, read directly from its package.json rather than duplicated as a hand-maintained constant -- the local fallback agent-comms#198 calls for once wire-mesh#179 (wire-mesh-core self-advertising CORE_VERSION_GOSSIP_KEY on every self-advert) makes the value moot for a REMOTE peer. own-version.ts (wire-mesh-core's own internal module producing that gossiped value) is not exported as a package subpath, so this side cannot import its OWN_VERSION constant directly -- but it is exactly this side's own installed wire-mesh-core/package.json version, which is exported ("./package.json") and is what own-version.ts itself reads to produce OWN_VERSION in the first place.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isVersionedPackageJson } from "./package-version.js";

let cachedVersion: string | undefined;

/** This process's own installed wire-mesh-core version. Resolved via import.meta.resolve (Node's own module resolver) rather than a static JSON import, so it always reads whatever wire-mesh-core is actually installed at runtime -- immune to any bundler that might otherwise inline a JSON import at agent-comms' own build time. Cached after the first successful read, matching getOwnPackageVersion's own convention. */
export function getWireMeshCoreVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;
  const packageJsonUrl = import.meta.resolve("wire-mesh-core/package.json");
  const parsed: unknown = JSON.parse(
    readFileSync(fileURLToPath(packageJsonUrl), "utf-8"),
  );
  if (!isVersionedPackageJson(parsed)) {
    throw new Error(
      `wire-mesh-core's package.json at ${packageJsonUrl} has no "version" string`,
    );
  }
  cachedVersion = parsed.version;
  return cachedVersion;
}

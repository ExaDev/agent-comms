/**
 * Every extension the `pi` manifest in package.json names must ship in the published package. `pi install npm:agent-comms` reported success and then could not load the extension when the manifest pointed at `src/`, which `files` did not publish (ExaDev/agent-comms#412, #440); nothing in the suite noticed, because the manifest and the tarball were never compared.
 *
 * The tarball contents come from `npm pack --dry-run`, the same file selection a publish uses, so a `files` entry or an ignore rule that drops the manifest's path fails here and not in a user's install.
 *
 * The same manifest declares `typebox`, which the pi bridge imports directly. Pi supplies that package to extensions and maps the specifier to its own copy, so declaring it in `dependencies` installs a second physical copy that shadows the mapping and makes Pi warn on every start (ExaDev/agent-comms#455).
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(import.meta.dirname, "../..");

// Packages Pi supplies to extensions, from the host-provided list in Pi's package docs.
const HOST_PROVIDED_PACKAGES = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "@sinclair/typebox",
  "typebox",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function manifestExtensions(): string[] {
  const manifest = readJson(path.join(packageRoot, "package.json"));
  if (!isRecord(manifest) || !isRecord(manifest.pi)) {
    throw new Error("package.json has no pi manifest");
  }
  const { extensions } = manifest.pi;
  if (!isStringArray(extensions)) {
    throw new Error("package.json pi.extensions is not a list of paths");
  }
  return extensions;
}

function packedPaths(): string[] {
  // --ignore-scripts keeps prepack and prepare out of a listing that only needs the file selection.
  const result = spawnSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    { cwd: packageRoot, encoding: "utf-8" },
  );
  if (result.status !== 0) {
    throw new Error(`npm pack --dry-run failed: ${result.stderr}`);
  }
  const listing: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(listing) || !isRecord(listing[0])) {
    throw new Error("npm pack --dry-run printed no package listing");
  }
  const { files } = listing[0];
  if (!Array.isArray(files)) {
    throw new Error("npm pack --dry-run listing has no files");
  }
  return files.map((file: unknown) => {
    if (!isRecord(file) || typeof file.path !== "string") {
      throw new Error("npm pack --dry-run listed a file without a path");
    }
    return file.path;
  });
}

describe("the pi manifest", () => {
  it("names at least one extension, so the loop below cannot pass by checking nothing", () => {
    expect(manifestExtensions().length).toBeGreaterThan(0);
  });

  it("names only extensions that exist in the repository", () => {
    for (const extension of manifestExtensions()) {
      expect(fs.existsSync(path.join(packageRoot, extension)), extension).toBe(
        true,
      );
    }
  });

  it("names only extensions the published package contains", () => {
    const packed = new Set(packedPaths());
    for (const extension of manifestExtensions()) {
      expect(packed.has(path.posix.normalize(extension)), extension).toBe(true);
    }
  });

  it("declares host-provided packages as wildcard peers, never dependencies", () => {
    const manifest = readJson(path.join(packageRoot, "package.json"));
    if (!isRecord(manifest)) {
      throw new Error("package.json is not an object");
    }
    const dependencies = isRecord(manifest.dependencies)
      ? Object.keys(manifest.dependencies)
      : [];
    const peers = isRecord(manifest.peerDependencies)
      ? manifest.peerDependencies
      : {};
    for (const name of HOST_PROVIDED_PACKAGES) {
      expect(dependencies, `${name} must not be a dependency`).not.toContain(
        name,
      );
    }
    // The pi bridge imports `typebox`, so it must be declared as a peer, and `"*"` lets Pi's own copy satisfy it.
    expect(peers.typebox).toBe("*");
  });
});

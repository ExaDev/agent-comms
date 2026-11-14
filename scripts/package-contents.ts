/**
 * Fails when the files a package tarball would hold include a test, a test helper, a test runner, a module of test support, a compiled source of the dashboard's browser application or a build tool's configuration, none of which the package may publish: it ships what a consumer runs or reads.
 *
 * Usage: tsx scripts/package-contents.ts [--listing <file>]. With no option it lists the tarball with `npm pack --dry-run --json` and checks that listing. `--listing` reads a JSON array of paths instead, which is how the check is tested.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** What marks a path as test material: a `test` directory at any depth, a `.test.` file, or a helper, runner or setup module. */
/** What marks a path as the dashboard's browser application or a build tool's configuration, which the bundled web assets and the build replace: a `web/frontend` directory, or a `<tool>.config.*` file. */
const BUILD_ONLY = /(^|\/)web\/frontend\/|(^|\/)[a-z-]+\.config\.[^/]*$/u;

const TEST_MATERIAL = /(^|\/)test\/|\.test\.|\.(helper|runner|setup)\./u;

/** How many offending paths the failure message shows. */
const SHOWN = 10;

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

/** The paths of an `npm pack --dry-run --json` listing. */
function packedPaths(): string[] {
  const output: unknown = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }),
  );
  const first: unknown = Array.isArray(output) ? output[0] : undefined;
  const files: unknown =
    typeof first === "object" && first !== null && "files" in first
      ? first.files
      : undefined;
  if (!Array.isArray(files)) {
    throw new Error("npm pack --dry-run --json listed no files");
  }

  return files.map((file: unknown) => {
    if (
      typeof file !== "object" ||
      file === null ||
      !("path" in file) ||
      typeof file.path !== "string"
    ) {
      throw new Error("a listed file has no path");
    }

    return file.path;
  });
}

const flag = process.argv.indexOf("--listing");
const listed: unknown =
  flag === -1
    ? packedPaths()
    : JSON.parse(readFileSync(String(process.argv[flag + 1]), "utf8"));
if (!isStringArray(listed) || listed.length === 0) {
  throw new Error("the listing is not a non-empty list of paths");
}
const offending = listed.filter(
  (path) => TEST_MATERIAL.test(path) || BUILD_ONLY.test(path),
);
if (offending.length > 0) {
  console.error(
    `the package would publish ${String(offending.length)} files that are tests, test support, browser sources of the dashboard or build configuration, such as:\n${offending.slice(0, SHOWN).join("\n")}`,
  );
  process.exit(1);
}
console.log(
  `the package lists ${String(listed.length)} files and none is test material, a browser source or a build configuration`,
);

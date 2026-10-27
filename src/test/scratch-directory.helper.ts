import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const scratchDirectories = new Set<string>();

/**
 * Creates a fresh directory under the system temporary directory and tracks it for removal.
 *
 * Every test that needs a throwaway directory goes through here instead of calling `fs.mkdtempSync` itself, because nothing else removes what a test run leaves in the system temporary directory, and a suite that creates directories per test accumulates them across runs without bound.
 *
 * A tracked directory is removed by `removeScratchDirectory`, by `removeAllScratchDirectories` (run after each test file by `scratch-directory.setup.ts`) or when the process exits, whichever comes first.
 * @param prefix - Prefix of the directory name; `fs.mkdtempSync` appends six random characters.
 * @returns Absolute path of the new, empty directory.
 */
export function scratchDirectory(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(tmpdir(), prefix));
  scratchDirectories.add(dir);
  return dir;
}

/**
 * Removes one directory made by `scratchDirectory`, with everything inside it, and stops tracking it. A directory that is already gone is not an error, so a test that cleans up after itself and the file-level cleanup can both run.
 * @param dir - A path returned by `scratchDirectory`.
 */
export function removeScratchDirectory(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
  scratchDirectories.delete(dir);
}

/** Removes every directory `scratchDirectory` has made in this process that is still tracked. */
export function removeAllScratchDirectories(): void {
  for (const dir of [...scratchDirectories]) {
    removeScratchDirectory(dir);
  }
}

// Backstop for a process that ends without running the file-level cleanup (a test file that throws while loading, a worker stopped between files). The exit event does not run for a process killed by a signal, which is why the file-level cleanup exists as well.
process.once("exit", removeAllScratchDirectories);

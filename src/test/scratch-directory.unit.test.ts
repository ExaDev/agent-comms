/**
 * Unit tests for the scratch-directory helper every test uses for throwaway directories: creation under the system temporary directory, explicit removal, removal of everything tracked, and the exit backstop that removes what a process leaves behind.
 */
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  removeAllScratchDirectories,
  removeScratchDirectory,
  scratchDirectory,
} from "./scratch-directory.helper.js";

const HELPER_PATH = fileURLToPath(
  new URL("./scratch-directory.helper.ts", import.meta.url),
);

describe("scratchDirectory", () => {
  it("creates an empty directory under the system temporary directory with the given prefix", () => {
    const dir = scratchDirectory("scratch-helper-create-");

    expect(path.dirname(dir)).toBe(tmpdir());
    expect(path.basename(dir)).toMatch(/^scratch-helper-create-.+/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("gives each call its own directory", () => {
    const first = scratchDirectory("scratch-helper-distinct-");
    const second = scratchDirectory("scratch-helper-distinct-");

    expect(first).not.toBe(second);
  });
});

describe("removeScratchDirectory", () => {
  it("removes the directory with everything inside it", () => {
    const dir = scratchDirectory("scratch-helper-remove-");
    fs.mkdirSync(path.join(dir, "nested"));
    fs.writeFileSync(path.join(dir, "nested", "file.txt"), "content");

    removeScratchDirectory(dir);

    expect(fs.existsSync(dir)).toBe(false);
  });

  it("accepts a directory that is already gone", () => {
    const dir = scratchDirectory("scratch-helper-twice-");
    removeScratchDirectory(dir);

    expect(() => {
      removeScratchDirectory(dir);
    }).not.toThrow();
  });
});

describe("removeAllScratchDirectories", () => {
  it("removes every directory still tracked and leaves other directories alone", () => {
    const tracked = scratchDirectory("scratch-helper-all-a-");
    const alsoTracked = scratchDirectory("scratch-helper-all-b-");
    const untracked = fs.mkdtempSync(
      path.join(tmpdir(), "scratch-helper-untracked-"),
    );

    try {
      removeAllScratchDirectories();

      expect(fs.existsSync(tracked)).toBe(false);
      expect(fs.existsSync(alsoTracked)).toBe(false);
      expect(fs.existsSync(untracked)).toBe(true);
    } finally {
      fs.rmSync(untracked, { recursive: true, force: true });
    }
  });
});

describe("process exit", () => {
  it("removes the directories a process created and never cleaned up", () => {
    const home = scratchDirectory("scratch-helper-exit-");
    const script = [
      `import(${JSON.stringify(HELPER_PATH)}).then((helper) => {`,
      `  process.stdout.write(helper.scratchDirectory("scratch-helper-orphan-"));`,
      `});`,
    ].join("\n");

    const result = childProcess.spawnSync(
      process.execPath,
      ["--import", "tsx", "-e", script],
      {
        encoding: "utf8",
        env: { ...process.env, TMPDIR: home, TEMP: home, TMP: home },
      },
    );

    expect(result.status).toBe(0);
    const orphan = result.stdout;
    expect(path.dirname(orphan)).toBe(home);
    expect(fs.existsSync(orphan)).toBe(false);
    expect(
      fs
        .readdirSync(home)
        .filter((name) => name.startsWith("scratch-helper-orphan-")),
    ).toEqual([]);
  });
});

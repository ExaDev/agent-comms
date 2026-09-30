/**
 * Unit tests for petnames (core/petnames, agent-comms#345): the viewer's own labels, persisted in the viewer's storage and shared by every bridge reading the same directory.
 */

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Petnames } from "../core/petnames.js";

/** Mask isolating the permission bits from a stat mode's file-type bits. */
const PERMISSION_BITS_MASK = 0o777;
/** Owner-only read and write. */
const OWNER_ONLY_RW_PERMISSIONS = 0o600;

function tempDir(): string {
  return fs.mkdtempSync(path.join(tmpdir(), "agent-comms-petnames-"));
}

describe("Petnames", () => {
  it("keeps a label, keyed by the lowercase id, for every instance reading the same directory", () => {
    const dir = tempDir();
    new Petnames({ dir }).set("AABBCC", "  work laptop ");

    expect(new Petnames({ dir }).list()).toEqual(
      new Map([["aabbcc", "work laptop"]]),
    );
  });

  it("writes the label file owner-only", () => {
    const dir = tempDir();
    new Petnames({ dir }).set("aabbcc", "work laptop");

    const mode =
      fs.statSync(path.join(dir, "petnames.json")).mode & PERMISSION_BITS_MASK;
    expect(mode).toBe(OWNER_ONLY_RW_PERMISSIONS);
  });

  it("replaces a label and clears one, reporting whether there was one to clear", () => {
    const petnames = new Petnames({ dir: tempDir() });
    petnames.set("aabbcc", "old");
    petnames.set("aabbcc", "new");
    petnames.set("ddeeff", "other");

    expect(petnames.clear("aabbcc")).toBe(true);
    expect(petnames.clear("aabbcc")).toBe(false);
    expect(petnames.list()).toEqual(new Map([["ddeeff", "other"]]));
  });

  it("refuses a label with a control sequence in it, and keeps nothing", () => {
    const petnames = new Petnames({ dir: tempDir() });

    expect(() => petnames.set("aabbcc", "evil\u001b[2J")).toThrow(
      /petname must be/,
    );
    expect(petnames.list()).toEqual(new Map());
  });

  it("works in memory when given no directory", () => {
    const petnames = new Petnames();
    petnames.set("aabbcc", "in memory");

    expect(petnames.list()).toEqual(new Map([["aabbcc", "in memory"]]));
  });
});

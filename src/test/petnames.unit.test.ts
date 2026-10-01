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

/** A device-id is a 64-character hex SHA-256 digest; petnames are keyed by full device-ids only. */
const DEVICE_ID_HEX_LENGTH = 64;
const DEVICE_A = "a".repeat(DEVICE_ID_HEX_LENGTH);
const DEVICE_D = "d".repeat(DEVICE_ID_HEX_LENGTH);
const DEVICE_E = "e".repeat(DEVICE_ID_HEX_LENGTH);

function petnamesFile(dir: string): string {
  return path.join(dir, "petnames.json");
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(tmpdir(), "agent-comms-petnames-"));
}

describe("Petnames", () => {
  it("keeps a label, keyed by the lowercase id, for every instance reading the same directory", () => {
    const dir = tempDir();
    new Petnames({ dir }).set(DEVICE_A.toUpperCase(), "  work laptop ");

    expect(new Petnames({ dir }).list()).toEqual(
      new Map([[DEVICE_A, "work laptop"]]),
    );
  });

  it("writes the label file owner-only", () => {
    const dir = tempDir();
    new Petnames({ dir }).set(DEVICE_A, "work laptop");

    const mode = fs.statSync(petnamesFile(dir)).mode & PERMISSION_BITS_MASK;
    expect(mode).toBe(OWNER_ONLY_RW_PERMISSIONS);
  });

  it("replaces a label and clears one, reporting whether there was one to clear", () => {
    const petnames = new Petnames({ dir: tempDir() });
    petnames.set(DEVICE_A, "old");
    petnames.set(DEVICE_A, "new");
    petnames.set(DEVICE_D, "other");

    expect(petnames.clear(DEVICE_A)).toBe(true);
    expect(petnames.clear(DEVICE_A)).toBe(false);
    expect(petnames.list()).toEqual(new Map([[DEVICE_D, "other"]]));
  });

  it("refuses a label with a control sequence in it, and keeps nothing", () => {
    const petnames = new Petnames({ dir: tempDir() });

    expect(() => petnames.set(DEVICE_A, "evil\u001b[2J")).toThrow(
      /petname must be/,
    );
    expect(petnames.list()).toEqual(new Map());
  });

  it("works in memory when given no directory", () => {
    const petnames = new Petnames();
    petnames.set(DEVICE_A, "in memory");

    expect(petnames.list()).toEqual(new Map([[DEVICE_A, "in memory"]]));
  });

  it("refuses to label anything but a full device-id", () => {
    const petnames = new Petnames({ dir: tempDir() });

    for (const notADevice of [
      "aabbcc",
      DEVICE_A.slice(1),
      `${DEVICE_A}0`,
      "z".repeat(DEVICE_ID_HEX_LENGTH),
    ]) {
      expect(() => petnames.set(notADevice, "typo")).toThrow(
        expect.objectContaining({ code: "INVALID_DEVICE" }),
      );
    }
    expect(petnames.list()).toEqual(new Map());
  });

  it("keeps every valid label when one entry on disk is damaged, and drops only that entry", () => {
    const dir = tempDir();
    fs.writeFileSync(
      petnamesFile(dir),
      JSON.stringify({
        [DEVICE_A]: "Alice laptop",
        [DEVICE_D]: 7,
        [DEVICE_E]: "evil\u001b[2J",
        short: "typo",
      }),
    );
    const petnames = new Petnames({ dir });

    expect(petnames.list()).toEqual(new Map([[DEVICE_A, "Alice laptop"]]));
    petnames.set(DEVICE_D, "Carol");
    expect(new Petnames({ dir }).list()).toEqual(
      new Map([
        [DEVICE_A, "Alice laptop"],
        [DEVICE_D, "Carol"],
      ]),
    );
  });

  it("refuses to read a file that is not a JSON object, and leaves it as it is rather than writing over it", () => {
    const dir = tempDir();
    fs.writeFileSync(petnamesFile(dir), "{not json");
    const petnames = new Petnames({ dir });

    expect(() => petnames.list()).toThrow(/not valid JSON/);
    expect(() => petnames.set(DEVICE_A, "Alice")).toThrow(/not valid JSON/);
    fs.writeFileSync(petnamesFile(dir), "[]");
    expect(() => petnames.clear(DEVICE_A)).toThrow(/JSON object/);
    expect(fs.readFileSync(petnamesFile(dir), "utf-8")).toBe("[]");
  });
});

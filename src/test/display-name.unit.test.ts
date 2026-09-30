/**
 * Unit tests for the one display convention (core/display-name, agent-comms#345): petname, then the self-asserted name, then the short id, and what a display name may contain.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_DISPLAY_NAME_LENGTH,
  SHORT_ID_LENGTH,
  formatDisplayName,
  parseDisplayName,
  shortId,
} from "../core/display-name.js";

/** A device-id is a 64-character lowercase hex SHA-256 digest. */
const DEVICE_ID_HEX_LENGTH = 64;
const HEX_DIGITS = "0123456789abcdef";
/** An id whose every prefix differs from every other's, so a wrong prefix length shows. */
const ID = HEX_DIGITS.repeat(DEVICE_ID_HEX_LENGTH / HEX_DIGITS.length);

describe("formatDisplayName", () => {
  it("puts the petname first, then the self-asserted name quoted, then the short id", () => {
    expect(
      formatDisplayName({
        id: ID,
        petname: "work laptop",
        selfName: "joe-mbp",
      }),
    ).toBe(`work laptop "joe-mbp" ${shortId(ID)}`);
  });

  it("shows the self-asserted name and short id when the viewer has no petname", () => {
    expect(formatDisplayName({ id: ID, selfName: "joe-mbp" })).toBe(
      `"joe-mbp" ${shortId(ID)}`,
    );
  });

  it("falls back to the short id alone when nothing is named", () => {
    expect(formatDisplayName({ id: ID })).toBe(shortId(ID));
  });

  it("does not repeat a self-asserted name that only echoes the petname", () => {
    expect(
      formatDisplayName({ id: ID, petname: "joe-mbp", selfName: "joe-mbp" }),
    ).toBe(`joe-mbp ${shortId(ID)}`);
  });

  it("shortens an id to a prefix of it", () => {
    expect(shortId(ID)).toHaveLength(SHORT_ID_LENGTH);
    expect(ID.startsWith(shortId(ID))).toBe(true);
  });
});

describe("parseDisplayName", () => {
  it("accepts a name and trims the space around it", () => {
    expect(parseDisplayName("  Joe's laptop ")).toBe("Joe's laptop");
  });

  it("refuses an empty name, one over the length limit, and one carrying a control sequence", () => {
    expect(parseDisplayName("   ")).toBeUndefined();
    expect(
      parseDisplayName("x".repeat(MAX_DISPLAY_NAME_LENGTH + 1)),
    ).toBeUndefined();
    expect(parseDisplayName("x".repeat(MAX_DISPLAY_NAME_LENGTH))).toBe(
      "x".repeat(MAX_DISPLAY_NAME_LENGTH),
    );
    expect(parseDisplayName("evil\u001b[2Jname")).toBeUndefined();
    expect(parseDisplayName("tab\tname")).toBeUndefined();
    expect(parseDisplayName("c1\u009bname")).toBeUndefined();
  });
});

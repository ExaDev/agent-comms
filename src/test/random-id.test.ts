import { describe, it, expect } from "vitest";
import { randomId } from "../core/random-id.js";

/** 128-bit (16-byte) random payload, matching a UUIDv4's own random length -- see random-id.ts's RANDOM_ID_BYTE_LENGTH. */
const EXPECTED_RANDOM_ID_BYTE_LENGTH = 16;

describe("randomId", () => {
  it("returns 16 bytes", () => {
    const id = randomId();
    expect(id.length).toBe(EXPECTED_RANDOM_ID_BYTE_LENGTH);
  });

  it("returns a different value on each call", () => {
    const a = randomId();
    const b = randomId();
    expect(a).not.toEqual(b);
  });
});

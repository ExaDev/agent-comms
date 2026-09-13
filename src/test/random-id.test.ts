import { describe, it, expect } from "vitest";
import { randomId } from "../core/random-id.js";

describe("randomId", () => {
  it("returns 16 bytes", () => {
    const id = randomId();
    expect(id.length).toBe(16);
  });

  it("returns a different value on each call", () => {
    const a = randomId();
    const b = randomId();
    expect(a).not.toEqual(b);
  });
});

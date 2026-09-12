import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomId } from "../core/random-id.js";

describe("randomId", () => {
  it("returns 16 bytes", () => {
    const id = randomId();
    assert.equal(id.length, 16);
  });

  it("returns a different value on each call", () => {
    const a = randomId();
    const b = randomId();
    assert.notDeepEqual(a, b);
  });
});

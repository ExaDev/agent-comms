import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomTokenId } from "../core/token-id.js";

describe("randomTokenId", () => {
  it("returns 16 bytes", () => {
    const id = randomTokenId();
    assert.equal(id.length, 16);
  });

  it("returns a different value on each call", () => {
    const a = randomTokenId();
    const b = randomTokenId();
    assert.notDeepEqual(a, b);
  });
});

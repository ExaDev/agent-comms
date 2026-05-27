/**
 * Unit tests for boot-logic.ts — local server detection and connection flag.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { isLocalHost, hasConnectedBefore } from "../boot-logic.js";

// ---------------------------------------------------------------------------
// isLocalHost
// ---------------------------------------------------------------------------

describe("isLocalHost", () => {
  it("returns true for localhost:3000", () => {
    assert.strictEqual(isLocalHost("localhost:3000"), true);
  });

  it("returns true for localhost without port", () => {
    assert.strictEqual(isLocalHost("localhost"), true);
  });

  it("returns true for 127.0.0.1:19877", () => {
    assert.strictEqual(isLocalHost("127.0.0.1:19877"), true);
  });

  it("returns true for 127.0.0.1 without port", () => {
    assert.strictEqual(isLocalHost("127.0.0.1"), true);
  });

  it("returns true for 127.1.2.3:8080", () => {
    assert.strictEqual(isLocalHost("127.1.2.3:8080"), true);
  });

  it("returns false for exadev.github.io", () => {
    assert.strictEqual(isLocalHost("exadev.github.io"), false);
  });

  it("returns false for example.com:3000", () => {
    assert.strictEqual(isLocalHost("example.com:3000"), false);
  });

  it("returns false for 192.168.1.1", () => {
    assert.strictEqual(isLocalHost("192.168.1.1"), false);
  });

  it("returns false for empty string", () => {
    assert.strictEqual(isLocalHost(""), false);
  });

  it("returns false for localhost.example.com", () => {
    assert.strictEqual(isLocalHost("localhost.example.com"), false);
  });
});

// ---------------------------------------------------------------------------
// hasConnectedBefore
// ---------------------------------------------------------------------------

describe("hasConnectedBefore", () => {
  let storage: Storage;

  beforeEach(() => {
    // Use a simple Map-backed Storage stub
    const map = new Map<string, string>();
    storage = {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        map.set(key, value);
      },
      removeItem: (key: string) => {
        map.delete(key);
      },
      clear: () => map.clear(),
      get length() {
        return map.size;
      },
      key: (_index: number) => null,
    };
  });

  it("returns false when flag is not set", () => {
    assert.strictEqual(hasConnectedBefore(storage), false);
  });

  it("returns true when flag is set to 'true'", () => {
    storage.setItem("agent-comms-connected", "true");
    assert.strictEqual(hasConnectedBefore(storage), true);
  });

  it("returns false when flag is set to something other than 'true'", () => {
    storage.setItem("agent-comms-connected", "false");
    assert.strictEqual(hasConnectedBefore(storage), false);
  });
});

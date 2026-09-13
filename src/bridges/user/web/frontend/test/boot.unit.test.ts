/**
 * Unit tests for boot-logic.ts — local server detection and connection flag.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { isLocalHost, hasConnectedBefore } from "../boot-logic.js";

// ---------------------------------------------------------------------------
// isLocalHost
// ---------------------------------------------------------------------------

describe("isLocalHost", () => {
  it("returns true for localhost:3000", () => {
    expect(isLocalHost("localhost:3000")).toBe(true);
  });

  it("returns true for localhost without port", () => {
    expect(isLocalHost("localhost")).toBe(true);
  });

  it("returns true for 127.0.0.1:19877", () => {
    expect(isLocalHost("127.0.0.1:19877")).toBe(true);
  });

  it("returns true for 127.0.0.1 without port", () => {
    expect(isLocalHost("127.0.0.1")).toBe(true);
  });

  it("returns true for 127.1.2.3:8080", () => {
    expect(isLocalHost("127.1.2.3:8080")).toBe(true);
  });

  it("returns false for exadev.github.io", () => {
    expect(isLocalHost("exadev.github.io")).toBe(false);
  });

  it("returns false for example.com:3000", () => {
    expect(isLocalHost("example.com:3000")).toBe(false);
  });

  it("returns false for 192.168.1.1", () => {
    expect(isLocalHost("192.168.1.1")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isLocalHost("")).toBe(false);
  });

  it("returns false for localhost.example.com", () => {
    expect(isLocalHost("localhost.example.com")).toBe(false);
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
    expect(hasConnectedBefore(storage)).toBe(false);
  });

  it("returns true when flag is set to 'true'", () => {
    storage.setItem("agent-comms-connected", "true");
    expect(hasConnectedBefore(storage)).toBe(true);
  });

  it("returns false when flag is set to something other than 'true'", () => {
    storage.setItem("agent-comms-connected", "false");
    expect(hasConnectedBefore(storage)).toBe(false);
  });
});

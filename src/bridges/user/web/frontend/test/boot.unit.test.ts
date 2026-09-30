/**
 * Unit tests for boot-logic.ts: the connection flag and the auto-connect decision.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { hasConnectedBefore, shouldAutoConnect } from "../boot-logic.js";

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

// ---------------------------------------------------------------------------
// shouldAutoConnect
// ---------------------------------------------------------------------------

describe("shouldAutoConnect", () => {
  const storageReturning = (value: string | null): Storage => ({
    getItem: () => value,
    setItem: () => undefined,
    removeItem: () => undefined,
    clear: () => undefined,
    length: 0,
    key: () => null,
  });
  const never = storageReturning(null);
  const before = storageReturning("true");

  it.each([
    ["localhost:19877", "http:"],
    ["127.0.0.1:4000", "http:"],
    ["192.168.1.10:4000", "http:"],
    ["studio.local:4000", "http:"],
  ])(
    "connects at once for a first visit served by a bridge at %s over %s",
    (host, protocol) => {
      expect(shouldAutoConnect({ host, protocol }, never)).toBe(true);
    },
  );

  it("waits for the user on a first visit to a standalone deployment", () => {
    expect(
      shouldAutoConnect(
        { host: "exadev.github.io", protocol: "https:" },
        never,
      ),
    ).toBe(false);
  });

  it("connects at once on a standalone deployment once the user has connected before", () => {
    expect(
      shouldAutoConnect(
        { host: "exadev.github.io", protocol: "https:" },
        before,
      ),
    ).toBe(true);
  });
});

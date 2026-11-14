/**
 * The dashboard's half of pairing: a secret handed over in the address is kept and removed from the address, a malformed one is ignored, and storage that cannot be reached is survived.
 */

import { describe, expect, it, vi } from "vitest";
import {
  PAIRING_STORAGE_KEY,
  capturePairing,
  forgetPairing,
  pairingSecretInFragment,
  storedPairingSecret,
  type PairingStorage,
} from "../pairing.js";

const SECRET_HEX_LENGTH = 64;
const SECRET = "c".repeat(SECRET_HEX_LENGTH);
const OTHER_SECRET = "d".repeat(SECRET_HEX_LENGTH);

function memoryStorage(initial?: string): PairingStorage & {
  held: () => string | undefined;
} {
  let value = initial;
  return {
    getItem: () => value ?? null,
    setItem: (_key, next) => {
      value = next;
    },
    removeItem: () => {
      value = undefined;
    },
    held: () => value,
  };
}

const brokenStorage: PairingStorage = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
  removeItem: () => {
    throw new Error("blocked");
  },
};

describe("the fragment the pairing page opens the dashboard with", () => {
  it("carries the secret as #pair=", () => {
    expect(pairingSecretInFragment(`#pair=${SECRET}`)).toBe(SECRET);
    expect(pairingSecretInFragment(`pair=${SECRET}`)).toBe(SECRET);
    expect(pairingSecretInFragment(`#x=1&pair=${SECRET}`)).toBe(SECRET);
  });

  it.each([
    "",
    "#",
    "#pair=",
    "#pair=short",
    `#pair=${SECRET.toUpperCase()}`,
    `#other=${SECRET}`,
  ])("holds no secret in %j", (hash) => {
    expect(pairingSecretInFragment(hash)).toBeUndefined();
  });
});

describe("capturePairing", () => {
  it("keeps a secret from the address and removes the fragment from the address in place", () => {
    const storage = memoryStorage();
    const replaceState =
      vi.fn<(data: null, unused: string, url: string) => void>();

    const held = capturePairing(
      { hash: `#pair=${SECRET}`, pathname: "/agent-comms/", search: "?room=a" },
      { replaceState },
      storage,
    );

    expect(held).toBe(SECRET);
    expect(storage.held()).toBe(SECRET);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/agent-comms/?room=a");
  });

  it("replaces a secret held earlier with the one handed over", () => {
    const storage = memoryStorage(OTHER_SECRET);

    capturePairing(
      { hash: `#pair=${SECRET}`, pathname: "/", search: "" },
      { replaceState: () => undefined },
      storage,
    );

    expect(storage.held()).toBe(SECRET);
  });

  it("returns the stored secret when the address carries none, and leaves the address alone", () => {
    const replaceState =
      vi.fn<(data: null, unused: string, url: string) => void>();

    const held = capturePairing(
      { hash: "", pathname: "/", search: "" },
      { replaceState },
      memoryStorage(SECRET),
    );

    expect(held).toBe(SECRET);
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("holds nothing for a browser that was never paired", () => {
    expect(
      capturePairing(
        { hash: "", pathname: "/", search: "" },
        { replaceState: () => undefined },
        memoryStorage(),
      ),
    ).toBeUndefined();
  });

  it("ignores a stored value of the wrong form", () => {
    expect(storedPairingSecret(memoryStorage("not a secret"))).toBeUndefined();
  });

  it("still serves the page load when storage cannot be written", () => {
    expect(
      capturePairing(
        { hash: `#pair=${SECRET}`, pathname: "/", search: "" },
        { replaceState: () => undefined },
        brokenStorage,
      ),
    ).toBe(SECRET);
    expect(storedPairingSecret(brokenStorage)).toBeUndefined();
  });

  it("forgets the secret", () => {
    const storage = memoryStorage(SECRET);

    forgetPairing(storage);

    expect(storage.held()).toBeUndefined();
    expect(() => {
      forgetPairing(brokenStorage);
    }).not.toThrow();
  });
});

it("keeps the secret under one named key", () => {
  expect(PAIRING_STORAGE_KEY).toBe("agent-comms-pairing-secret");
});

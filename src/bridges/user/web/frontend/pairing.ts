/**
 * The dashboard's half of pairing (see ../web-pairing.ts for the design): taking the secret the bridge's pairing page hands over in the address, keeping it, and reporting whether one is held.
 *
 * The secret is kept in the storage of the dashboard's own origin, which every page of that origin can read, so it separates a browser profile that was never paired from one that was, and not pages that share this storage.
 */

import {
  PAIRING_FRAGMENT_PARAM,
  PAIRING_SECRET_PATTERN,
} from "../pairing-protocol.js";

/** The storage key the secret is kept under. */
export const PAIRING_STORAGE_KEY = "agent-comms-pairing-secret";

/** The parts of `Storage` pairing uses. */
export interface PairingStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

/** The parts of `window.location` and `window.history` pairing uses. */
export interface PairingLocation {
  hash: string;
  pathname: string;
  search: string;
}

export interface PairingHistory {
  replaceState: (data: null, unused: string, url: string) => void;
}

/** The secret a storage holds, or undefined when it holds none or one of the wrong form. */
export function storedPairingSecret(
  storage: Readonly<PairingStorage>,
): string | undefined {
  try {
    const value = storage.getItem(PAIRING_STORAGE_KEY);
    return value !== null && PAIRING_SECRET_PATTERN.test(value)
      ? value
      : undefined;
  } catch {
    // Storage that cannot be read (a private window, blocked site data) holds no secret.
    return undefined;
  }
}

/** The secret an address's fragment carries as `#pair=<secret>`, or undefined. */
export function pairingSecretInFragment(hash: string): string | undefined {
  const params = new URLSearchParams(
    hash.startsWith("#") ? hash.slice(1) : hash,
  );
  const value = params.get(PAIRING_FRAGMENT_PARAM);
  return value !== null && PAIRING_SECRET_PATTERN.test(value)
    ? value
    : undefined;
}

/**
 * Takes a secret handed over in the address: keeps it, and removes the fragment from the address in place (the history entry is replaced, so the secret is not left in history). Returns the secret now held, from the address if it carried one, else from storage, else undefined. A fragment of the wrong form is left alone.
 */
export function capturePairing(
  location: Readonly<PairingLocation>,
  history: Readonly<PairingHistory>,
  storage: Readonly<PairingStorage>,
): string | undefined {
  const handed = pairingSecretInFragment(location.hash);
  if (handed === undefined) return storedPairingSecret(storage);
  try {
    storage.setItem(PAIRING_STORAGE_KEY, handed);
  } catch {
    // Not kept when storage cannot be written: the secret still serves this page load.
  }
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  return handed;
}

/** Forgets the secret, for a browser that is no longer to be paired. */
export function forgetPairing(storage: Readonly<PairingStorage>): void {
  try {
    storage.removeItem(PAIRING_STORAGE_KEY);
  } catch {
    // Nothing to forget in storage that cannot be reached.
  }
}

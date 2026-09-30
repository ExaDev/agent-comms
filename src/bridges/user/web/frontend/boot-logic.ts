/**
 * Boot logic helpers, extracted from main.tsx for testability.
 *
 * Determines whether the app should connect to a mesh on load: when a bridge served the page, or when the user has connected before.
 */

import { isServedByBridge } from "./served-by-bridge.js";

/**
 * Check whether the user has previously connected to a mesh.
 * Reads the "agent-comms-connected" flag from the given storage.
 */
export function hasConnectedBefore(storage: Storage): boolean {
  return storage.getItem("agent-comms-connected") === "true";
}

/**
 * Whether to connect on load without waiting for the user. A page served by a bridge dials its own origin, which cannot raise Chrome's local-access prompt, so it connects at once; a standalone deployment connects on load only for a user who has connected before, and otherwise shows a connect prompt.
 */
export function shouldAutoConnect(
  location: { readonly host: string; readonly protocol: string },
  storage: Storage,
): boolean {
  return isServedByBridge(location) || hasConnectedBefore(storage);
}

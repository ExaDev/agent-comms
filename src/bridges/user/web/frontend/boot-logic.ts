/**
 * Boot logic helpers — extracted from main.tsx for testability.
 *
 * Determines whether the app is served from a local mesh server
 * (vs standalone PWA), and whether the user has previously connected.
 */

/** Pattern matching localhost or 127.x.x.x with optional port. */
const LOCAL_HOST_PATTERN = /^(localhost|127\.\d+\.\d+\.\d+)(:\d+)?$/;

/**
 * Returns true if the given host string refers to a local server.
 * Matches localhost:port, 127.x.x.x:port, or either without a port.
 */
export function isLocalHost(host: string): boolean {
  return LOCAL_HOST_PATTERN.test(host);
}

/**
 * Check whether the user has previously connected to a mesh.
 * Reads the "agent-comms-connected" flag from the given storage.
 */
export function hasConnectedBefore(storage: Storage): boolean {
  return storage.getItem("agent-comms-connected") === "true";
}

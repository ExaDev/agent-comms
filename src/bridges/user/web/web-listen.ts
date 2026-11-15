/**
 * Binding the web server's listening socket: the first free port of a range, each port bound for real, with a fallback to an operating-system port. Split from server.ts to keep that file under the line cap.
 */

import { once } from "node:events";
import type * as http from "node:http";

/** Whether a listen failure means the port is already taken. */
function isAddressInUse(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EADDRINUSE"
  );
}

/** Binds `server` to `port` on `host`; true once listening, false when the port is taken, and rejects on any other failure. */
async function tryListen(
  server: http.Server,
  port: number,
  host: string,
): Promise<boolean> {
  // once() rejects when the server emits "error" before "listening", and removes both of its listeners either way.
  const listening = once(server, "listening");
  server.listen(port, host);
  try {
    await listening;
    return true;
  } catch (error) {
    if (isAddressInUse(error)) return false;
    throw error;
  }
}

/**
 * Binds `server` to the first of `ports` that is free, in order, and returns the port it holds.
 *
 * Each port is bound for real, so a port another process takes between two attempts is simply skipped, where a test-then-bind would hand two processes the same port. Only "already in use" moves on to the next port: any other bind error rejects with that error. When `fallBackToAnyPort` is set and every port is taken the operating system picks one; when nothing could be bound the error names every port tried.
 */
export async function listen(
  server: http.Server,
  host: string,
  ports: readonly number[],
  fallBackToAnyPort: boolean,
): Promise<number> {
  for (const port of ports) {
    if (await tryListen(server, port, host)) return boundPortOf(server);
  }
  if (fallBackToAnyPort && (await tryListen(server, 0, host))) {
    return boundPortOf(server);
  }
  const tried = fallBackToAnyPort
    ? [...ports.map(String), "an operating-system port"]
    : ports.map(String);
  throw new Error(
    `Agent Comms web UI: every port tried is already in use on ${host}: ${tried.join(", ")}`,
  );
}

/** The port a listening server holds. */
function boundPortOf(server: http.Server): number {
  const addr = server.address();
  if (typeof addr !== "object" || addr === null) {
    throw new Error("Agent Comms web UI: the listening server has no address");
  }
  return addr.port;
}

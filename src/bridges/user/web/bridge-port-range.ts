/**
 * The loopback TCP ports a bridge's web server looks for, and the dashboard looks in.
 *
 * A bridge binds the first free port of this range, so a hosted dashboard that cannot know a bridge's port finds it by trying each port in order. The range starts at the number the first-contact beacon uses over UDP, which is a separate port space: the two never contend.
 *
 * Shared by the Node server and the browser frontend, so it imports nothing from either.
 */

import { acquireTicket } from "./pairing-handshake.js";

/** First port of the range a bridge's web server binds and the dashboard probes. */
export const BRIDGE_PORT_BASE = 19877;

/** Where the pairing page of a bridge on `port` is. */
export function bridgePairingPageUrl(port: number): string {
  return `http://127.0.0.1:${String(port)}/pair`;
}

/** How many consecutive ports, from the base, belong to the range. */
export const BRIDGE_PORT_COUNT = 10;

/** How long the probe waits for one port to accept the mesh socket before it counts as not a bridge: a listener that accepts and never answers must not stall the walk over the rest of the range. A bridge answers on loopback well inside this. */
export const BRIDGE_PROBE_TIMEOUT_MS = 1000;

/** The lowest port of the range an unprivileged process may bind. */
export const LOWEST_UNPRIVILEGED_PORT = 1024;

/** The highest TCP port. */
export const HIGHEST_PORT = 65_535;

/** Thrown for a base that is not a whole number or would put a port of the range outside 1024 to 65535. */
export class InvalidBridgePortBaseError extends Error {
  readonly base: number;

  constructor(base: number) {
    super(
      `Bridge port base ${String(base)} is not an integer whose ${String(BRIDGE_PORT_COUNT)} ports all lie in ${String(LOWEST_UNPRIVILEGED_PORT)} to ${String(HIGHEST_PORT)}`,
    );
    this.name = "InvalidBridgePortBaseError";
    this.base = base;
  }
}

/**
 * The ports of the range in the order both sides try them.
 * @param base - The first port; defaults to {@link BRIDGE_PORT_BASE}. Tests pass a range of their own.
 * @throws InvalidBridgePortBaseError when `base` is not an integer or a port of the range would fall outside 1024 to 65535.
 */
export function bridgePortRange(base: number = BRIDGE_PORT_BASE): number[] {
  if (
    !Number.isInteger(base) ||
    base < LOWEST_UNPRIVILEGED_PORT ||
    base + BRIDGE_PORT_COUNT - 1 > HIGHEST_PORT
  ) {
    throw new InvalidBridgePortBaseError(base);
  }
  return Array.from({ length: BRIDGE_PORT_COUNT }, (_, index) => base + index);
}

/** The address of a bridge's mesh socket on `port`. */
export function bridgeMeshUrl(port: number): string {
  return `ws://127.0.0.1:${String(port)}/ws/mesh`;
}

/**
 * Whether a bridge's mesh socket (the dashboard's own endpoint, `/ws/mesh`) accepts a connection on the port within the timeout. Another kind of server, a refused port and a listener that never answers all give false: a WebSocket handshake needs a bridge to complete, and unlike a plain fetch it is readable from a hosted page without CORS headers.
 * @param port - The loopback port to try.
 * @param options - `timeoutMs` is how long to wait for the handshake (default {@link BRIDGE_PROBE_TIMEOUT_MS}); `pairingSecret` is the secret this browser was paired with. With one, the listener must first prove it holds it (frontend/pairing-handshake.ts), and a listener that cannot, a bridge that was paired with another secret and a port nothing answers on are all not a bridge; the secret is never sent, and a listener that is not the bridge is sent one random nonce and nothing else. Without one the port is a bridge when its mesh socket accepts a connection.
 */
export async function isBridgeAt(
  port: number,
  options?: Readonly<{
    timeoutMs?: number | undefined;
    pairingSecret?: string | undefined;
  }>,
): Promise<boolean> {
  const timeoutMs = options?.timeoutMs ?? BRIDGE_PROBE_TIMEOUT_MS;
  const pairingSecret = options?.pairingSecret;
  if (pairingSecret !== undefined) {
    return (await acquireTicket(port, pairingSecret, timeoutMs)) !== undefined;
  }
  return new Promise((resolve) => {
    const socket = new WebSocket(bridgeMeshUrl(port));
    const settle = (isBridge: boolean): void => {
      socket.close();
      resolve(isBridge);
    };
    AbortSignal.timeout(timeoutMs).addEventListener(
      "abort",
      () => {
        settle(false);
      },
      { once: true },
    );
    socket.addEventListener(
      "open",
      () => {
        settle(true);
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        settle(false);
      },
      { once: true },
    );
  });
}

/**
 * The first port of the range that `isBridge` accepts, tried in range order, or undefined when none does.
 * @param isBridge - Decides whether a bridge answers on a port.
 * @param base - The first port of the range; defaults to {@link BRIDGE_PORT_BASE}.
 */
export async function findBridgePort(
  isBridge: (port: number) => Promise<boolean>,
  base: number = BRIDGE_PORT_BASE,
): Promise<number | undefined> {
  for (const port of bridgePortRange(base)) {
    if (await isBridge(port)) return port;
  }
  return undefined;
}

/**
 * Looks for a bridge in the range and, when one answers, passes its mesh socket address to `onFound`; calls nothing when none does. Resolves once the walk is over.
 * @param onFound - Receives the mesh socket address of the first bridge found.
 * @param options - `base` is the first port of the range (default {@link BRIDGE_PORT_BASE}); `timeoutMs` is the wait for each port (default {@link BRIDGE_PROBE_TIMEOUT_MS}); `pairingSecret` is offered to every port tried.
 */
export async function probeForBridge(
  onFound: (meshUrl: string) => void,
  options?: Readonly<{
    base?: number | undefined;
    timeoutMs?: number | undefined;
    pairingSecret?: string | undefined;
  }>,
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? BRIDGE_PROBE_TIMEOUT_MS;
  const port = await findBridgePort(
    async (candidate) =>
      isBridgeAt(candidate, {
        timeoutMs,
        pairingSecret: options?.pairingSecret,
      }),
    options?.base,
  );
  if (port !== undefined) onFound(bridgeMeshUrl(port));
}

/**
 * The loopback TCP ports a bridge's web server looks for, and the dashboard looks in.
 *
 * A bridge binds the first free port of this range, so a hosted dashboard that cannot know a bridge's port finds it by trying each port in order. The range starts at the number the first-contact beacon uses over UDP, which is a separate port space: the two never contend.
 *
 * Shared by the Node server and the browser frontend, so it imports nothing from either.
 */

/** First port of the range a bridge's web server binds and the dashboard probes. */
export const BRIDGE_PORT_BASE = 19877;

/** How many consecutive ports, from the base, belong to the range. */
export const BRIDGE_PORT_COUNT = 10;

/** How long the probe waits for one port to accept the mesh socket before it counts as not a bridge: a listener that accepts and never answers must not stall the walk over the rest of the range. A bridge answers on loopback well inside this. */
export const BRIDGE_PROBE_TIMEOUT_MS = 1000;

/**
 * The ports of the range in the order both sides try them.
 * @param base - The first port; defaults to {@link BRIDGE_PORT_BASE}. Tests pass a range of their own.
 */
export function bridgePortRange(base: number = BRIDGE_PORT_BASE): number[] {
  return Array.from({ length: BRIDGE_PORT_COUNT }, (_, index) => base + index);
}

/** The address of a bridge's mesh socket on `port`. */
export function bridgeMeshUrl(port: number): string {
  return `ws://127.0.0.1:${String(port)}/ws/mesh`;
}

/**
 * Whether a bridge's mesh socket (the dashboard's own endpoint, `/ws/mesh`) accepts a connection on the port within the timeout. Another kind of server, a refused port and a listener that never answers all give false: a WebSocket handshake needs a bridge to complete, and unlike a plain fetch it is readable from a hosted page without CORS headers.
 * @param port - The loopback port to try.
 * @param timeoutMs - How long to wait for the handshake; defaults to {@link BRIDGE_PROBE_TIMEOUT_MS}.
 */
export async function isBridgeAt(
  port: number,
  timeoutMs: number = BRIDGE_PROBE_TIMEOUT_MS,
): Promise<boolean> {
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
 * @param options - `base` is the first port of the range (default {@link BRIDGE_PORT_BASE}); `timeoutMs` is the wait for each port (default {@link BRIDGE_PROBE_TIMEOUT_MS}).
 */
export async function probeForBridge(
  onFound: (meshUrl: string) => void,
  options?: Readonly<{
    base?: number | undefined;
    timeoutMs?: number | undefined;
  }>,
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? BRIDGE_PROBE_TIMEOUT_MS;
  const port = await findBridgePort(
    async (candidate) => isBridgeAt(candidate, timeoutMs),
    options?.base,
  );
  if (port !== undefined) onFound(bridgeMeshUrl(port));
}

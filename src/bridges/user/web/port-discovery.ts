/**
 * Port discovery — walk up from a base port to find a free one.
 *
 * Extracted from server.ts so the logic can be unit-tested without
 * loading the full server module (which reads built assets at import time).
 */

import * as http from "node:http";

const WEB_HOST = "127.0.0.1";

/** Maximum number of ports to try when searching for a free one. */
export const DEFAULT_MAX_ATTEMPTS = 10;

/**
 * Try binding sequentially from `base`.
 * Returns the first port that succeeds, or undefined if all are taken.
 */
export function findFreePort(
  base: number,
  maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
): Promise<number | undefined> {
  return new Promise((resolve) => {
    let attempts = 0;

    function tryPort(port: number): void {
      if (attempts >= maxAttempts) {
        resolve(undefined);
        return;
      }
      attempts++;

      const probe = http.createServer();
      probe.on("error", () => {
        probe.close();
        tryPort(port + 1);
      });
      probe.listen(port, WEB_HOST, () => {
        const addr = probe.address();
        const actualPort = typeof addr === "object" && addr ? addr.port : port;
        probe.close(() => {
          resolve(actualPort);
        });
      });
    }

    tryPort(base);
  });
}

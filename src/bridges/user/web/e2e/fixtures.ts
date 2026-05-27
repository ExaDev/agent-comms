/**
 * E2e test fixture — starts the web server on a dynamic port.
 *
 * Each test file gets its own isolated server instance.
 * Imports from source (tsx resolves at runtime).
 */

import { test as base, expect } from "@playwright/test";
import { createWebServer, type WebServerHandle } from "../server.js";
import net from "node:net";

/** Allocate a random free port by binding to port 0. */
function allocFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

interface Fixtures {
  server: WebServerHandle;
  port: number;
}

export const test = base.extend<Fixtures>({
  server: async ({}, use: (handle: WebServerHandle) => Promise<void>) => {
    // Each test gets its own coordinator port to avoid EADDRINUSE races
    // when the previous test's TLS transport hasn't released 19876 yet.
    const coordinatorPort = await allocFreePort();
    const handle = await createWebServer(0, undefined, coordinatorPort);

    // Wait for server to be listening
    await new Promise<void>((resolve) => {
      if (handle.server.listening) {
        resolve();
      } else {
        handle.server.on("listening", resolve);
      }
    });

    await use(handle);

    handle.wss.close();
    handle.server.close();
    await handle.controller.shutdown();
  },
  port: async ({ server }, use: (port: number) => Promise<void>) => {
    const addr = server.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    await use(port);
  },
});

export { expect };

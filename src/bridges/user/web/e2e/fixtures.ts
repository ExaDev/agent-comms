/**
 * E2e test fixture — starts the web server on a dynamic port.
 *
 * Each test file gets its own isolated server instance.
 * Imports from source (tsx resolves at runtime).
 */

import { test as base, expect } from "@playwright/test";
import { createWebServer, type WebServerHandle } from "../server.js";

interface Fixtures {
  server: WebServerHandle;
  port: number;
}

export const test = base.extend<Fixtures>({
  server: async ({}, use: (handle: WebServerHandle) => Promise<void>) => {
    const handle = await createWebServer(0);

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

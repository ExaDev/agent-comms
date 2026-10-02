/**
 * E2e test fixture — starts the web server on a dynamic port.
 *
 * Each test file gets its own isolated server instance.
 * Imports from source (tsx resolves at runtime).
 */

import { test as base } from "@playwright/test";
import { createWebServer, type WebServerHandle } from "../server.js";
import {
  freeLocalPort,
  unreachableHubUrl,
} from "../../../../test/hub-helpers.js";

interface Fixtures {
  server: WebServerHandle;
  port: number;
}

export const test = base.extend<Fixtures>({
  server: async ({}, use: (handle: WebServerHandle) => Promise<void>) => {
    // Each test gets its own coordinator port to avoid EADDRINUSE races
    // when the previous test's TLS transport hasn't released 19876 yet.
    const coordinatorPort = await freeLocalPort();
    const hubUrl = await unreachableHubUrl();
    // First contact defaults to one machine-wide UDP port, which would let the dashboards of parallel workers discover each other and list each other's agents.
    const firstContactPort = await freeLocalPort();
    const handle = await createWebServer({
      coordinatorPort,
      firstContactPort,
      hubUrl,
    });

    // Wait for server to be listening
    await new Promise<void>((resolve) => {
      if (handle.server.listening) {
        resolve();
      } else {
        handle.server.on("listening", resolve);
      }
    });

    await use(handle);

    // wss.close()/server.close() are asynchronous -- neither actually releases its port until its optional callback fires. Awaiting that here keeps a later test's allocFreePort() from being handed a port this handle hasn't genuinely released yet.
    // wss.close() does not close existing connections and only calls back once every client has disconnected, so a page still holding its WebSocket open would stall this teardown until the test timeout. Terminate the clients first.
    for (const client of handle.wss.clients) client.terminate();
    await new Promise<void>((resolve) => {
      handle.wss.close(() => {
        resolve();
      });
    });
    await new Promise<void>((resolve) => {
      handle.server.close(() => {
        resolve();
      });
    });
    await handle.controller.shutdown();
  },
  port: async ({ server }, use: (port: number) => Promise<void>) => {
    const addr = server.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    await use(port);
  },
});

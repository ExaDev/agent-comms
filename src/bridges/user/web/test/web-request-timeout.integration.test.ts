/**
 * The request timeout, through the real server with the timeout injected small: a request whose headers or body stop arriving is answered 408 and its connection closed, and a WebSocket that has been upgraded is not subject to it however long it stays open.
 */

import * as net from "node:net";
import { afterEach, expect, it } from "vitest";
import WS from "ws";
import {
  freeLocalPort,
  unreachableHubUrl,
} from "../../../../test/hub-helpers.js";
import { createWebServer, type WebServerHandle } from "../server.js";

const REQUEST_TIMEOUT_MS = 300;
const CHECK_INTERVAL_MS = 50;
const WAIT_MS = 10_000;
const LONGER_THAN_TIMEOUT_MS = 900;
const LOOPBACK = "127.0.0.1";

const handles: WebServerHandle[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) {
    handle.wss.close();
    handle.server.closeAllConnections();
    await new Promise<void>((resolve) => {
      handle.server.close(() => {
        resolve();
      });
    });
    await handle.controller.shutdown();
  }
});

async function startServer(): Promise<number> {
  const handle = await createWebServer({
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    connectionsCheckingIntervalMs: CHECK_INTERVAL_MS,
    coordinatorPort: await freeLocalPort(),
    firstContactPort: await freeLocalPort(),
    hubUrl: await unreachableHubUrl(),
  });
  handles.push(handle);
  const address = handle.server.address();
  return typeof address === "object" && address ? address.port : 0;
}

async function exchange(
  port: number,
  request: string,
): Promise<{ received: string; closed: boolean }> {
  return new Promise((resolve) => {
    const socket = net.connect(port, LOOPBACK, () => {
      socket.write(request);
    });
    let received = "";
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString();
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      resolve({ received, closed: true });
    });
    setTimeout(() => {
      socket.destroy();
      resolve({ received, closed: false });
    }, WAIT_MS).unref();
  });
}

it("answers 408 and closes when the headers stop arriving", async () => {
  const port = await startServer();

  const result = await exchange(
    port,
    `POST /api/action HTTP/1.1\r\nHost: ${LOOPBACK}:${String(port)}\r\n`,
  );

  expect(result.closed).toBe(true);
  expect(result.received.startsWith("HTTP/1.1 408")).toBe(true);
});

it("answers 408 and closes when the body stops arriving", async () => {
  const port = await startServer();

  const result = await exchange(
    port,
    `POST /api/action HTTP/1.1\r\nHost: ${LOOPBACK}:${String(port)}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"a`,
  );

  expect(result.closed).toBe(true);
  expect(result.received.startsWith("HTTP/1.1 408")).toBe(true);
});

it("does not close an upgraded WebSocket for being open longer than the timeout", async () => {
  const port = await startServer();
  const socket = new WS(`ws://${LOOPBACK}:${String(port)}/ws/mesh`);
  socket.on("error", () => undefined);
  await new Promise<void>((resolve) => {
    socket.once("open", () => {
      resolve();
    });
  });

  await new Promise<void>((resolve) => {
    setTimeout(resolve, LONGER_THAN_TIMEOUT_MS);
  });

  expect(socket.readyState).toBe(WS.OPEN);
  socket.close();
});

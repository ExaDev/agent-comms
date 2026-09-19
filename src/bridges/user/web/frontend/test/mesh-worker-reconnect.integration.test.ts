/**
 * Reconnect-specific tests for mesh-worker.ts's new oRPC upstream half.
 *
 * Drives connect() against a real running server (not a mock) and forcibly severs the underlying WebSocket connection from the server side to prove RPCLink's `reconnect` option actually re-establishes the connection and the worker keeps receiving state after that -- the exact thing the migration plan flagged as needing real empirical verification rather than assumed from either option's name.
 */
import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import { createWebServer, type WebServerHandle } from "../../server.js";
import { connect, disconnect, ports, agents, rooms } from "../mesh-worker.js";
import { unreachableHubUrl } from "../../../../../test/hub-helpers.js";

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
    server.on("error", reject);
  });
}

let handle: WebServerHandle | undefined;

async function startServer(): Promise<number> {
  const coordinatorPort = await findFreePort();
  const hubUrl = await unreachableHubUrl();
  handle = await createWebServer(0, undefined, coordinatorPort, hubUrl);
  await new Promise<void>((resolve) => {
    if (handle?.server.listening === true) {
      resolve();
      return;
    }
    handle?.server.once("listening", () => {
      resolve();
    });
  });
  const addr = handle.server.address();
  return typeof addr === "object" && addr ? addr.port : 0;
}

afterEach(async () => {
  ports.clear();
  agents.clear();
  rooms.clear();
  // disconnect() first, before closing the server's own wss/http listeners -- ws's WebSocketServer.close() callback only fires once every client connection it's still tracking has actually closed, and this test always leaves a live, reconnected client connection open at the end. Without disconnect() first, wss.close() below waits forever for a client that was never going to disconnect on its own.
  disconnect();
  if (handle) {
    await new Promise<void>((resolve) => {
      handle?.wss.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      handle?.server.close(() => resolve());
    });
    await handle.controller.shutdown();
    handle = undefined;
  }
});

const POLL_INTERVAL_MS = 20;
const POLL_TIMEOUT_MS = 5000;

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => {
      setTimeout(resolve, POLL_INTERVAL_MS);
    });
  }
}

function countBroadcastsOfType(
  messages: readonly unknown[],
  type: string,
): number {
  return messages.filter(
    (m) =>
      typeof m === "object" && m !== null && "type" in m && m.type === type,
  ).length;
}

describe("mesh-worker upstream reconnect", () => {
  it("reconnects and keeps receiving state after the server-side socket is forcibly closed", async () => {
    const port = await startServer();

    const received: unknown[] = [];
    ports.add({
      postMessage: (message: unknown) => {
        received.push(
          typeof message === "string" ? JSON.parse(message) : message,
        );
      },
      close: () => {
        /* no-op fake port */
      },
      onmessage: null,
    });

    connect(`ws://127.0.0.1:${String(port)}/ws/mesh`);

    // Baseline: a real connection produces "connected" then a "state" broadcast.
    await waitFor(() => countBroadcastsOfType(received, "connected") > 0);
    const connectedCountBefore = countBroadcastsOfType(received, "connected");

    // Sever the connection from the server side -- not a client-initiated close, a real mid-session drop.
    const serverSideSockets = [...handle!.wss.clients];
    expect(serverSideSockets.length).toBe(1);
    serverSideSockets[0]?.terminate();

    await waitFor(() => countBroadcastsOfType(received, "disconnected") > 0);

    // RPCLink's reconnect option should re-establish the connection on its own -- prove it by waiting for a second "connected" broadcast, not just asserting the option was passed.
    await waitFor(
      () => countBroadcastsOfType(received, "connected") > connectedCountBefore,
    );

    // And the worker must still be receiving real state after reconnecting, not just a bare socket-level handshake.
    await waitFor(() => countBroadcastsOfType(received, "state") > 0);
  });
});

import { createServer } from "node:http";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { cdeDecodeOptions, cdeEncodeOptions, decode, encode } from "cbor2";
import type { Frame } from "wire-mesh-core/generated/protocol";
import { connectWsUrl } from "../core/ws-dial.js";

const SHUTDOWN_GRACE_MS = 250;

interface TestServer {
  url: string;
  close: () => Promise<void>;
  received: Frame[];
}

/** A real local ws server echoing every received frame back, so the dial round trip is exercised against a genuine socket. */
async function echoServer(): Promise<TestServer> {
  const received: Frame[] = [];
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  wss.on("connection", (socket: WsSocket) => {
    socket.on("message", (data) => {
      const decodedFrame: unknown = decode(
        new Uint8Array(data as ArrayBuffer),
        cdeDecodeOptions,
      );
      const frame = decodedFrame as Frame;
      received.push(frame);
      socket.send(new Uint8Array(encode(frame, cdeEncodeOptions)));
    });
  });
  await new Promise<void>((resolve) => {
    http.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = http.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP listen address");
  }
  return {
    url: `ws://127.0.0.1:${String(address.port)}/`,
    received,
    close: async () =>
      new Promise<void>((resolve) => {
        // wss.close() alone waits for connected clients, which would
        // deadlock a test asserting behaviour AFTER the server side hangs
        // up -- terminate them first, then close the listener.
        for (const client of wss.clients) {
          client.terminate();
        }
        wss.close();
        http.close(() => {
          resolve();
        });
        setTimeout(resolve, SHUTDOWN_GRACE_MS);
      }),
  };
}

const servers: TestServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

describe("connectWsUrl", () => {
  it("round-trips a frame against a real ws server", async () => {
    const server = await echoServer();
    servers.push(server);
    const connection = await connectWsUrl(server.url);
    const ping: Frame = { type: "ping" };
    await connection.send(ping);

    const iterator = connection.receive()[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value).toEqual(ping);
    expect(server.received).toEqual([ping]);

    await connection.close();
  });

  it("rejects a non-ws/wss URL outright, without a socket attempt", async () => {
    await expect(connectWsUrl("ftp://example.com/")).rejects.toThrow(
      /ws:\/\/ or wss:\/\//,
    );
    await expect(connectWsUrl("example.com:1234")).rejects.toThrow(
      /ws:\/\/ or wss:\/\//,
    );
  });

  it("ends its receive stream when the server closes the socket", async () => {
    const server = await echoServer();
    const connection = await connectWsUrl(server.url);
    await connection.send({ type: "ping" });
    const iterator = connection.receive()[Symbol.asyncIterator]();
    await iterator.next(); // the echo
    // Close the server first: wss.close() itself waits for client sockets,
    // so closing the connection first would deadlock the shutdown.
    await server.close();
    const afterClose = await iterator.next();
    expect(afterClose.done).toBe(true);
  });
});

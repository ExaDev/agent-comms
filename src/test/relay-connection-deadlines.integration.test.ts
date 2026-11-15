/**
 * A client of the relay is unauthenticated until it gossips an admitted device, so none of its connections is held open without a deadline: a request that is not a WebSocket upgrade is answered and closed, a request that stalls is cut off, and a WebSocket that never gossips an admitted device is closed.
 */

import * as net from "node:net";
import { cdeEncodeOptions, encode } from "cbor2";
import { afterEach, expect, it } from "vitest";
import WS from "ws";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { RelayServer } from "../core/relay-server.js";

const LOOPBACK = "127.0.0.1";
const REQUEST_TIMEOUT_MS = 300;
const ADMISSION_TIMEOUT_MS = 400;
const CHECK_INTERVAL_MS = 50;
const WAIT_MS = 10_000;
const BEFORE_DEADLINE_MS = 100;

const servers: RelayServer[] = [];
const sockets: { destroy: () => void }[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) await server.stop();
});

async function startRelay(): Promise<number> {
  const server = new RelayServer({
    host: LOOPBACK,
    isAdmitted: () => false,
    onError: () => undefined,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    admissionTimeoutMs: ADMISSION_TIMEOUT_MS,
    connectionsCheckingIntervalMs: CHECK_INTERVAL_MS,
  });
  servers.push(server);
  await server.start();
  const [url] = server.addresses();
  if (url === undefined) throw new Error("the relay offers no address");
  return Number(new URL(url).port);
}

/** What a raw client receives until the relay closes the connection, and whether it closed within the wait. */
async function exchange(
  port: number,
  send: (socket: net.Socket) => void,
): Promise<{ received: string; closed: boolean }> {
  return new Promise((resolve) => {
    const socket = net.connect(port, LOOPBACK, () => {
      send(socket);
    });
    sockets.push(socket);
    let received = "";
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString();
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      resolve({ received, closed: true });
    });
    setTimeout(() => {
      resolve({ received, closed: false });
    }, WAIT_MS).unref();
  });
}

it("answers a complete request that is not an upgrade at once and closes the connection", async () => {
  const port = await startRelay();

  const result = await exchange(port, (socket) => {
    socket.write(`GET / HTTP/1.1\r\nHost: ${LOOPBACK}\r\n\r\n`);
  });

  expect(result.closed).toBe(true);
  expect(result.received.startsWith("HTTP/1.1 426")).toBe(true);
  expect(result.received.toLowerCase()).toContain("connection: close");
});

it("cuts off a client that sends part of its headers and stops", async () => {
  const port = await startRelay();

  const result = await exchange(port, (socket) => {
    socket.write(`GET / HTTP/1.1\r\nHost: ${LOOPBACK}\r\n`);
  });

  expect(result.closed).toBe(true);
  expect(result.received.startsWith("HTTP/1.1 408")).toBe(true);
});

it("cuts off a client that connects and sends nothing", async () => {
  const port = await startRelay();

  const result = await exchange(port, () => undefined);

  expect(result.closed).toBe(true);
});

it("closes a WebSocket that has not gossiped an admitted device in time, and not before", async () => {
  const port = await startRelay();
  const socket = new WS(`ws://${LOOPBACK}:${String(port)}/`);
  sockets.push({
    destroy: () => {
      socket.terminate();
    },
  });
  socket.on("error", () => undefined);
  await new Promise<void>((resolve) => {
    socket.once("open", () => {
      resolve();
    });
  });
  const closed = new Promise<void>((resolve) => {
    socket.once("close", () => {
      resolve();
    });
  });

  await new Promise<void>((resolve) => {
    setTimeout(resolve, BEFORE_DEADLINE_MS);
  });
  expect(socket.readyState).toBe(WS.OPEN);

  await closed;

  expect(socket.readyState).toBe(WS.CLOSED);
});

const JUNK_DEVICE_BYTE = 7;
const DEVICE_ID_BYTES = 32;
const JUNK_KEY_BYTES = 65;
const JUNK_SIGNATURE_BYTES = 64;
const ES256 = -7;
const FORGED_WAIT_MS = 5000;

it("closes a WebSocket whose gossip names an admitted device with a key and signature that do not verify", async () => {
  const device = new Uint8Array(DEVICE_ID_BYTES).fill(JUNK_DEVICE_BYTE);
  const server = new RelayServer({
    host: LOOPBACK,
    // The id is admitted, as every id an admitted peer gossips is.
    isAdmitted: (hex) => hex === deviceIdToHex(device),
    onError: () => undefined,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    admissionTimeoutMs: ADMISSION_TIMEOUT_MS,
    connectionsCheckingIntervalMs: CHECK_INTERVAL_MS,
  });
  servers.push(server);
  await server.start();
  const [url] = server.addresses();
  if (url === undefined) throw new Error("the relay offers no address");
  const socket = new WS(url);
  sockets.push({
    destroy: () => {
      socket.terminate();
    },
  });
  socket.on("error", () => undefined);
  const closed = new Promise<boolean>((resolve) => {
    socket.once("close", () => {
      resolve(true);
    });
    setTimeout(() => {
      resolve(false);
    }, FORGED_WAIT_MS).unref();
  });
  await new Promise<void>((resolve) => {
    socket.once("open", () => {
      resolve();
    });
  });

  socket.send(
    encode(
      {
        type: "gossip",
        peers: [
          {
            device,
            addresses: [],
            "snapshot-seconds": 1,
            "identity-key": {
              alg: ES256,
              "public-key": new Uint8Array(JUNK_KEY_BYTES).fill(1),
            },
            signature: new Uint8Array(JUNK_SIGNATURE_BYTES).fill(2),
          },
        ],
      },
      cdeEncodeOptions,
    ),
  );

  expect(await closed).toBe(true);
});

/**
 * The relay's WebSocket server bounds one message by MAX_RELAY_FRAME_BYTES on the length the frame declares: a message over it closes that connection with the too-big status, one of exactly the limit is not refused for its size, and the relay and its other connections carry on.
 */

import { EventEmitter } from "node:events";
import { afterEach, expect, it } from "vitest";
import WS from "ws";
import { MAX_RELAY_FRAME_BYTES, RelayServer } from "../core/relay-server.js";
import { waitFor } from "./test-transport.js";

const LOOPBACK = "127.0.0.1";
/** WebSocket close code for a message that is too big. */
const WS_MESSAGE_TOO_BIG = 1009;
const PAD_BYTE = 97;
const CLOSE_WAIT_MS = 10_000;
const BYTES_PER_MIB = 1_048_576;
const DESIGNED_LIMIT_MIB = 16;

const servers: RelayServer[] = [];

function collect(errors: readonly Error[]): (error: Error) => void {
  return (error) => {
    errors.push(error);
  };
}
const sockets: WS[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const server of servers.splice(0)) await server.stop();
});

async function startRelay(
  onError: (error: Error) => void,
): Promise<{ url: string }> {
  const server = new RelayServer({
    host: LOOPBACK,
    isAdmitted: () => false,
    onError,
  });
  servers.push(server);
  await server.start();
  const [url] = server.addresses();
  if (url === undefined) throw new Error("the relay offers no address");
  return { url };
}

async function connect(url: string): Promise<WS> {
  const socket = new WS(url);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => {
      resolve();
    });
    socket.once("error", reject);
  });
  return socket;
}

async function closeCodeAfterSending(
  socket: WS,
  bytes: number,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    socket.once("close", (code) => {
      resolve(code);
    });
    setTimeout(() => {
      reject(new Error("the socket was not closed"));
    }, CLOSE_WAIT_MS).unref();
    socket.send(Buffer.alloc(bytes, PAD_BYTE));
  });
}

it("closes a connection that sends a message one byte over the limit with the too-big status, and keeps its other connections and the listener", async () => {
  const errors: Error[] = [];
  const { url } = await startRelay(collect(errors));
  const bystander = await connect(url);
  const offender = await connect(url);

  const code = await closeCodeAfterSending(offender, MAX_RELAY_FRAME_BYTES + 1);

  expect(code).toBe(WS_MESSAGE_TOO_BIG);
  expect(bystander.readyState).toBe(WS.OPEN);
  const later = await connect(url);
  expect(later.readyState).toBe(WS.OPEN);
  expect(errors).toEqual([]);
});

it("does not refuse a message of exactly the limit for its size", async () => {
  const errors: Error[] = [];
  const { url } = await startRelay(collect(errors));
  const socket = await connect(url);

  const code = await closeCodeAfterSending(socket, MAX_RELAY_FRAME_BYTES);

  // The bytes are not a frame, so the connection is closed for that, a protocol error, and never for their size.
  expect(code).not.toBe(WS_MESSAGE_TOO_BIG);
});

it("states the limit as sixteen mebibytes", () => {
  expect(MAX_RELAY_FRAME_BYTES).toBe(DESIGNED_LIMIT_MIB * BYTES_PER_MIB);
});

it("settles connection accounting after an oversized message", async () => {
  const errors: Error[] = [];
  const { url } = await startRelay(collect(errors));
  const offender = await connect(url);
  await closeCodeAfterSending(offender, MAX_RELAY_FRAME_BYTES + 1);

  await waitFor(
    () => servers[0]?.connectionCount() === 0,
    "the relay forgot the closed connection",
  );
});

it("reports an error of its own listener through its error handler instead of throwing", async () => {
  const errors: Error[] = [];
  await startRelay(collect(errors));
  const listener: unknown = Reflect.get(servers[0] ?? {}, "http");
  if (!(listener instanceof EventEmitter)) {
    throw new Error("the relay has no HTTP listener");
  }
  const failure = new Error("listener failed");

  listener.emit("error", failure);

  expect(errors).toEqual([failure]);
});

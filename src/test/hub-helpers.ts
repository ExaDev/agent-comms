// Shared helpers for hub-mode integration tests: a real wire-mesh relay hub (createRelayHub -- the same domain logic the production mesh.exadev.io Durable Object runs) served over local WebSockets, canonical-CBOR framing for the ws bridge, and a condition-polling helper for the async discovery/gossip timing these tests exercise.

import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { cdeDecodeOptions, cdeEncodeOptions, decode, encode } from "cbor2";
import { frameSchema } from "wire-mesh-core/generated/protocol";
import { createRelayHub } from "wire-mesh-core/domain/relay-hub";
import type { Connection } from "wire-mesh-core/ports/transport";
import type { Frame } from "wire-mesh-core/generated/protocol";

const SHUTDOWN_GRACE_MS = 250;
const CLOSE_NORMAL = 1000; // RFC 6455 normal closure
const POLL_INTERVAL_MS = 25;
const DEFAULT_CONDITION_TIMEOUT_MS = 5_000;

export function cbor2ToBytes(frame: Frame): Uint8Array {
  return new Uint8Array(encode(frame, cdeEncodeOptions));
}

/** ws's own RawData type is `Buffer | ArrayBuffer | Buffer[]`, but every caller here sets `socket.binaryType = "arraybuffer"` before this ever fires, so a real message is always an ArrayBuffer at runtime -- narrowed with a guard rather than asserted, since ws's declared type is genuinely broader than what this specific binaryType configuration guarantees. */
function isArrayBuffer(data: unknown): data is ArrayBuffer {
  return data instanceof ArrayBuffer;
}

function wsReceiveStream(socket: WsSocket): AsyncIterable<Frame> {
  const pending: Frame[] = [];
  const waiters: {
    resolve: (result: IteratorResult<Frame>) => void;
    reject: (error: unknown) => void;
  }[] = [];
  let ended = false;
  socket.on("message", (data) => {
    if (!isArrayBuffer(data)) return;
    try {
      const decoded: unknown = decode(new Uint8Array(data), cdeDecodeOptions);
      const parsed = frameSchema.safeParse(decoded);
      if (!parsed.success) return;
      const waiter = waiters.shift();
      if (waiter !== undefined) {
        waiter.resolve({ value: parsed.data, done: false });
      } else {
        pending.push(parsed.data);
      }
    } catch {
      // Undecodable: drop, keeping the stream alive for the well-formed frames behind it (the hub's own tolerance).
    }
  });
  socket.on("close", () => {
    ended = true;
    for (const waiter of waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
  });
  socket.on("error", () => {
    ended = true;
    for (const waiter of waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
  });
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<Frame>> {
          const next = pending.shift();
          if (next !== undefined) {
            return { value: next, done: false };
          }
          if (ended) {
            return { value: undefined, done: true };
          }
          return new Promise<IteratorResult<Frame>>((resolve, reject) => {
            waiters.push({ resolve, reject });
          });
        },
      };
    },
  };
}

function wsConnection(socket: WsSocket): Connection {
  return {
    // async with no internal await, matching ws-dial.ts's own identical send() shape: promise-function-async requires the interface's Promise<void> return stay async, which is exactly what makes it have nothing to await.
    send: async (frame: Frame) => {
      socket.send(cbor2ToBytes(frame));
    },
    receive: () => wsReceiveStream(socket),
    close: async () => {
      socket.close(CLOSE_NORMAL);
    },
  };
}

/** A real relay hub served over ws: each accepted socket is wrapped as a Connection for createRelayHub, exactly what the production Durable Object does (pre-hibernation shape). Also exposes the hub's own live-connection count, since a test asserting a client-side disconnect actually reached the far end needs an observable on the hub itself, not just the client. */
export async function realHubOverWs(): Promise<{
  url: string;
  connectionCount: () => number;
  close: () => Promise<void>;
}> {
  const http: Server = createServer();
  const wss = new WebSocketServer({ server: http });
  const hub = createRelayHub();
  wss.on("connection", (socket: WsSocket) => {
    socket.binaryType = "arraybuffer";
    void hub.handleConnection(wsConnection(socket));
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
    connectionCount: () => wss.clients.size,
    close: async () =>
      new Promise<void>((resolve) => {
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

/** Polls `condition` until it's true or `timeoutMs` elapses, rejecting on timeout -- the shared shape every hub integration test uses to wait out real async gossip/discovery/close propagation rather than asserting immediately after firing an action. */
export async function waitForCondition(
  condition: () => boolean,
  timeoutMs = DEFAULT_CONDITION_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = (): void => {
      if (condition()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("condition not met within timeout"));
        return;
      }
      setTimeout(check, POLL_INTERVAL_MS);
    };
    check();
  });
}

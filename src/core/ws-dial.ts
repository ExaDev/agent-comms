// A ws-library dial adapter for outbound remote connections to a WebSocket-served hub (e.g. the mesh.exadev.io cloudflare-hub, which answers wss:// only): one CBOR frame per binary WebSocket message, the identical framing wire-mesh-node's own WebSocket transport uses, so a hub sees the same bytes from this client as from any other. Agent-comms' own edge adapter rather than a wire-mesh-node dependency because wire-mesh-node is not published to npm as a consumable package (a placeholder 0.0.0), while the dial is genuinely this app's concern at its own edge -- the same layering its TLS transport adapter already occupies.

import { WebSocket as WsSocket } from "ws";
import { cdeDecodeOptions, cdeEncodeOptions, decode, encode } from "cbor2";
import { frameSchema, type Frame } from "wire-mesh-core/generated/protocol";
import type { Connection } from "wire-mesh-core/ports/transport";

const CONNECT_TIMEOUT_MS = 10_000;
// RFC 6455 close codes, named rather than bare: 1000 normal closure, 1002 protocol error.
const CLOSE_NORMAL = 1000;
const CLOSE_PROTOCOL_ERROR = 1002;

/** Rejects addresses that are neither ws:// nor wss:// URLs -- a wrong-scheme dial would otherwise surface as an opaque socket error. */
function assertWsUrl(url: string): void {
  if (!/^wss?:\/\/./.test(url)) {
    throw new Error(`expected a ws:// or wss:// URL, got "${url}"`);
  }
}

export async function connectWsUrl(url: string): Promise<Connection> {
  assertWsUrl(url);
  return new Promise<Connection>((resolve, reject) => {
    const socket = new WsSocket(url);
    socket.binaryType = "arraybuffer";
    const timer = setTimeout(() => {
      socket.terminate();
      reject(
        new Error(
          `ws dial timed out after ${String(CONNECT_TIMEOUT_MS)}ms: ${url}`,
        ),
      );
    }, CONNECT_TIMEOUT_MS);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve(wrapSocket(socket));
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

function wrapSocket(socket: WsSocket): Connection {
  const pending: Frame[] = [];
  const waiters: {
    resolve: (result: IteratorResult<Frame>) => void;
    reject: (error: unknown) => void;
  }[] = [];
  let ended = false;
  let failure: Error | null = null;
  // Set synchronously the instant close() is called, well before the socket's own readyState transitions are visible to a concurrent caller. Unlike `ended` (only true once the "close" event actually arrives, which a real close handshake delays), this flag exists purely so a send() invoked after close() has started is rejected with a clean, expected error immediately, rather than reaching socket.send() and hitting ws's own "WebSocket is not open: readyState 2 (CLOSING)" (agent-comms#304).
  let closing = false;
  // Every send() call still awaiting its own socket-level callback, so close() can let them settle before tearing the socket down instead of racing a send that was already under way when close() was called.
  const pendingSends = new Set<Promise<void>>();

  function endAll(): void {
    ended = true;
    for (const waiter of waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
  }

  function failAll(error: Error): void {
    failure = error;
    ended = true;
    for (const waiter of waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  socket.on("message", (data) => {
    if (!(data instanceof ArrayBuffer)) {
      failAll(new Error("expected a binary WebSocket message"));
      socket.close(CLOSE_PROTOCOL_ERROR, "protocol error");
      return;
    }
    let frame: Frame;
    try {
      const decoded: unknown = decode(new Uint8Array(data), cdeDecodeOptions);
      const parsed = frameSchema.safeParse(decoded);
      if (!parsed.success) {
        // A decodable-but-unrecognised frame is dropped, keeping the connection -- version negotiation exists to tolerate it.
        return;
      }
      frame = parsed.data;
    } catch (error) {
      failAll(
        error instanceof Error
          ? error
          : new Error(`frame body failed to decode: ${String(error)}`),
      );
      socket.close(CLOSE_PROTOCOL_ERROR, "protocol error");
      return;
    }
    const waiter = waiters.shift();
    if (waiter) {
      waiter.resolve({ value: frame, done: false });
    } else {
      pending.push(frame);
    }
  });
  socket.on("close", endAll);
  socket.on("error", () => {
    // The receive stream's failure signal; the raw error is not otherwise actionable here.
  });

  const receiveStream: AsyncIterable<Frame> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<Frame>> {
          const next = pending.shift();
          if (next !== undefined) {
            return { value: next, done: false };
          }
          if (failure !== null) {
            throw failure;
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

  return {
    async send(frame: Frame): Promise<void> {
      if (ended || closing) {
        throw new Error("connection is closed");
      }
      const sent = new Promise<void>((resolve, reject) => {
        socket.send(
          new Uint8Array(encode(frame, cdeEncodeOptions)),
          (error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          },
        );
      });
      // Tracked from the same synchronous tick socket.send() was actually called in, so a close() that starts a moment later always sees this send if it was genuinely already under way.
      const tracked = sent.finally(() => {
        pendingSends.delete(tracked);
      });
      pendingSends.add(tracked);
      return tracked;
    },
    receive: () => receiveStream,
    close: async () => {
      // Reject anything sent from here on before it ever reaches the socket (the send() guard above), and let every send already in flight resolve or reject on its own terms first. Closing the socket out from under an in-flight send is what turns its own ordinary completion into a spurious "WebSocket is not open: readyState 2 (CLOSING)" (agent-comms#304).
      closing = true;
      await Promise.allSettled([...pendingSends]);
      if (ended) return;
      await new Promise<void>((resolve) => {
        socket.once("close", () => {
          resolve();
        });
        socket.close(CLOSE_NORMAL);
      });
    },
  };
}

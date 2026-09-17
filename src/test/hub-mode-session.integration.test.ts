// Integration: two real agent-comms WireMeshTransports discovering each other and exchanging messages through a real wire-mesh relay hub (createRelayHub -- the same domain logic the production mesh.exadev.io Durable Object runs) served over local WebSockets. This is agent-comms#151's own acceptance shape: the hub connection is a relay, not a coordinator -- no connect_request/introduce approval applies, peers discover each other via the hub's gossip forwarding + catch-up, and messages ride relay pairings (sendManageRequest's own targetDevice routing).

import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { cdeDecodeOptions, decode } from "cbor2";
import { frameSchema } from "wire-mesh-core/generated/protocol";
import { cbor2ToBytes } from "./hub-helpers.js";
import { createRelayHub } from "wire-mesh-core/domain/relay-hub";
import type { Connection } from "wire-mesh-core/ports/transport";
import type { Frame } from "wire-mesh-core/generated/protocol";
import { generateIdentity } from "../core/identity.js";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { WireMeshTransport } from "../core/wire-mesh-transport.js";
import type { TransportEvents } from "../core/transport.js";

const SHUTDOWN_GRACE_MS = 250;
const CLOSE_NORMAL = 1000; // RFC 6455 normal closure
const POLL_INTERVAL_MS = 25;

function recordingEvents(): TransportEvents & {
  messages: { from: string; text: string }[];
} {
  const messages: { from: string; text: string }[] = [];
  return {
    messages,
    onMessage: (handle, message) => {
      if (message.method === "peer_joined") {
        messages.push({ from: handle.id, text: message.peer.id });
      }
    },
    onPeerConnected: () => undefined,
    onPeerDisconnected: () => undefined,
    onIntroduction: () => undefined,
    onConnectionRequest: () => undefined,
    onPeerList: () => undefined,
    onPeerJoined: () => undefined,
    onBecomeCoordinator: () => undefined,
    onRevocationAnnounce: () => undefined,
    onPresenceAdvert: () => undefined,
  };
}

/** A real relay hub served over ws: each accepted socket is wrapped as a Connection for createRelayHub, exactly what the production Durable Object does (pre-hibernation shape). */
async function realHubOverWs(): Promise<{
  url: string;
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

function wsConnection(socket: WsSocket): Connection {
  return {
    send: async (frame: Frame) => {
      socket.send(cbor2ToBytes(frame));
    },
    receive: () => wsReceiveStream(socket),
    close: async () => {
      socket.close(CLOSE_NORMAL);
    },
  };
}

function wsReceiveStream(socket: WsSocket): AsyncIterable<Frame> {
  const pending: Frame[] = [];
  const waiters: {
    resolve: (result: IteratorResult<Frame>) => void;
    reject: (error: unknown) => void;
  }[] = [];
  let ended = false;
  socket.on("message", (data) => {
    void (async () => {
      try {
        const decoded: unknown = decode(
          new Uint8Array(data as ArrayBuffer),
          cdeDecodeOptions,
        );
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
    })();
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

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanups.splice(0)) {
    await close();
  }
});

describe("connectToHub", () => {
  it("two transports discover each other via the hub's gossip and exchange messages through relay pairings", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);

    const eventsA = recordingEvents();
    const eventsB = recordingEvents();
    const transportA = new WireMeshTransport(eventsA, generateIdentity());
    const transportB = new WireMeshTransport(eventsB, generateIdentity());
    await transportA.hub.connect(hub.url);
    await transportB.hub.connect(hub.url);

    // Discovery: each side's hubPeers should eventually list the other.
    const deviceA = await transportA.hub.ownDeviceHex();
    const deviceB = await transportB.hub.ownDeviceHex();
    await waitForCondition(() => {
      return (
        transportA.hub.peers().includes(deviceB) &&
        transportB.hub.peers().includes(deviceA)
      );
    });

    // Messaging: A sends to B via the hub; B's onMessage fires with A's device.
    await transportA.hub.sendToPeer(deviceB, {
      method: "peer_joined",
      peer: {
        id: "hub-says-hi",
        port: 0,
        startedAt: "2026-01-01T00:00:00.000Z",
      },
    });

    await waitForCondition(() => eventsB.messages.length > 0);
    expect(eventsB.messages[0]?.text).toBe("hub-says-hi");
    expect(eventsB.messages[0]?.from).toBe(deviceA);

    await transportA.shutdown();
    await transportB.shutdown();
  });
});

async function waitForCondition(
  condition: () => boolean,
  timeoutMs = 5_000,
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

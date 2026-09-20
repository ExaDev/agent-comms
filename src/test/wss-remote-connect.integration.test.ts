// Integration: connectToRemote against a ws:// URL, through a minimal in-test fake hub speaking the real protocol (handshake reply, connect_request answered with manage-ok) -- proving the URL branch drives the identical session + connect_request flow the TLS branch uses, without standing up a TLS stack or a deployed hub.

import { createServer, type Server } from "node:http";
import { TeardownStack } from "./hub-helpers.js";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { cdeDecodeOptions, cdeEncodeOptions, decode, encode } from "cbor2";
import type { Frame } from "wire-mesh-core/generated/protocol";
import { generateIdentity } from "../core/identity.js";
import { WireMeshTransport } from "../core/wire-mesh-transport.js";
import type { TransportEvents } from "../core/transport.js";

const SHUTDOWN_GRACE_MS = 250;
const GARBAGE_PORT = 0; // meaningless in URL form -- exactly what the branch should tolerate

function inertEvents(): TransportEvents {
  return {
    onMessage: () => undefined,
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

/** The minimal fake hub: replies to a handshake with a compatible one, answers every manage-request with manage-ok. Records every frame for assertions. */
async function fakeHub(): Promise<{
  url: string;
  received: Frame[];
  close: () => Promise<void>;
}> {
  const received: Frame[] = [];
  const http: Server = createServer();
  const wss = new WebSocketServer({ server: http });
  wss.on("connection", (socket: WsSocket) => {
    socket.on("message", (data) => {
      const decodedFrame: unknown = decode(
        new Uint8Array(data as ArrayBuffer),
        cdeDecodeOptions,
      );
      const frame = decodedFrame as Frame;
      received.push(frame);
      if (frame.type === "handshake") {
        const answer: Frame = {
          type: "handshake",
          version: frame.version,
          domains: frame.domains,
        };
        socket.send(new Uint8Array(encode(answer, cdeEncodeOptions)));
        return;
      }
      if (frame.type === "manage-request") {
        const response: Frame = {
          type: "manage-response",
          "request-id": frame["request-id"],
          outcome: { result: "ok" },
        };
        socket.send(new Uint8Array(encode(response, cdeEncodeOptions)));
      }
      // Gossip and everything else: tolerated, unanswered -- the hub's own forwarding is not this test's subject.
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
        // wss.close() alone waits for connected clients; terminate them first so shutdown cannot deadlock on the very connection under test.
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

const cleanups = new TeardownStack();

afterEach(async () => {
  await cleanups.run();
});

describe("connectToRemote with a ws:// URL", () => {
  it("dials the hub, handshakes, and sends connect_request through the same flow as TLS", async () => {
    const hub = await fakeHub();
    cleanups.push(hub.close);
    const identity = generateIdentity();
    const transport = new WireMeshTransport(inertEvents(), identity);

    await transport.connectToRemote({
      host: hub.url,
      port: GARBAGE_PORT,
      peerId: "peer-id",
      dataPort: 0,
      name: "test-agent",
      fingerprint: "",
    });

    // The fake hub saw the full flow the TLS branch also drives: this side's handshake, then the connect_request manage-request.
    const sawHandshake = hub.received.some((f) => f.type === "handshake");
    const connectRequest = hub.received.find(
      (f) => f.type === "manage-request",
    );
    expect(sawHandshake).toBe(true);
    expect(connectRequest).toBeDefined();

    await transport.shutdown();
  });

  it("rejects a non-ws/wss URL host outright rather than dialling garbage", async () => {
    const identity = generateIdentity();
    const transport = new WireMeshTransport(inertEvents(), identity);
    await expect(
      transport.connectToRemote({
        host: "ftp://example.com/",
        port: GARBAGE_PORT,
        peerId: "peer-id",
        dataPort: 0,
        name: "test-agent",
        fingerprint: "",
      }),
    ).rejects.toThrow(/hostname or a ws:\/\/ \/ wss:\/\//);
    await transport.shutdown();
  });
});

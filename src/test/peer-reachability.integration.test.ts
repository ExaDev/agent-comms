/**
 * What a transport does with a peer its dial could not reach: it reports the peer when it holds no live session with it, closes what answered, and ends the dial's claim, so that a peer that died before it was dialled does not stay in the peer list for ever (agent-comms#587).
 */
import { describe, expect, test } from "vitest";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import type { Connection } from "wire-mesh-core/ports/transport";
import { generateIdentity } from "../core/identity.js";
import { WireMeshTransport } from "../core/wire-mesh-transport.js";
import type { PeerInfo } from "../core/wire-protocol.js";
import { noopTransportEvents } from "./test-transport.js";

const DEVICE_ID_BYTES = 32;

describe("WireMeshTransport peers that cannot be reached", () => {
  function peerAt(id: string, port: number): PeerInfo {
    return { id, port, startedAt: new Date().toISOString() };
  }

  /** Replaces the wire transport a transport dials through, so a dial answers with a connection of the test's choosing. */
  function dialAnswering(
    transport: WireMeshTransport,
    connection: Connection,
  ): void {
    Reflect.set(transport, "wireTransport", {
      connect: async () => Promise.resolve(connection),
    });
  }

  function fakeConnection(peerDeviceId: Uint8Array | undefined): {
    connection: Connection;
    closed: () => number;
  } {
    let closes = 0;
    const connection = {
      peerDeviceId,
      send: async () => Promise.resolve(),
      receive: async function* () {
        yield* [];
      },
      close: async () => {
        closes += 1;
        return Promise.resolve();
      },
    } as unknown as Connection;
    return { connection, closed: () => closes };
  }

  test("an answer that holds another key than the peer's id names is reported unreachable, and the connection closed", async () => {
    const unreachable: string[] = [];
    const transport = new WireMeshTransport(
      noopTransportEvents({
        onPeerUnreachable: (peer) => void unreachable.push(peer.id),
      }),
      generateIdentity(),
    );
    const { connection, closed } = fakeConnection(
      new Uint8Array(DEVICE_ID_BYTES).fill(1),
    );
    dialAnswering(transport, connection);
    try {
      await transport.connectToPeer(peerAt("not-that-key", 1), "self");

      expect(unreachable).toEqual(["not-that-key"]);
      expect(closed()).toBe(1);
    } finally {
      await transport.shutdown();
    }
  });

  test("an answer with no device id at all is reported unreachable, and the connection closed", async () => {
    const unreachable: string[] = [];
    const transport = new WireMeshTransport(
      noopTransportEvents({
        onPeerUnreachable: (peer) => void unreachable.push(peer.id),
      }),
      generateIdentity(),
    );
    const { connection, closed } = fakeConnection(undefined);
    dialAnswering(transport, connection);
    try {
      await transport.connectToPeer(peerAt("no-id", 1), "self");

      expect(unreachable).toEqual(["no-id"]);
      expect(closed()).toBe(1);
    } finally {
      await transport.shutdown();
    }
  });

  test("a session that cannot be opened ends the dial's claim and closes the connection, so a later dial can start", async () => {
    const identity = generateIdentity();
    const peerHex = deviceIdToHex(new Uint8Array(DEVICE_ID_BYTES).fill(1));
    const transport = new WireMeshTransport(noopTransportEvents(), identity);
    const { connection, closed } = fakeConnection(
      new Uint8Array(DEVICE_ID_BYTES).fill(1),
    );
    dialAnswering(transport, connection);
    const failure = Promise.reject(new Error("identity unavailable"));
    failure.catch(() => undefined);
    Reflect.set(transport, "identityReady", failure);
    try {
      await expect(
        transport.connectToPeer(peerAt(peerHex, 1), "self"),
      ).rejects.toThrow("identity unavailable");

      const dials: unknown = Reflect.get(transport, "dataDials");
      expect(dials instanceof Map && dials.has(peerHex)).toBe(false);
      expect(closed()).toBe(1);
    } finally {
      await transport.shutdown();
    }
  });
});

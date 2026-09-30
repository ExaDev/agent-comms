/**
 * Unit tests for FirstContact (agent-comms#341): the default-on UDP presence that finds peers without a coordinator. Real dgram sockets over loopback, on OS-assigned free ports (the presence's own port is injectable for exactly this), exercising the two-packet protocol: probes answered immediately to the probe's own source port, beacons discovered and deduplicated by peerId, self-beacons dropped, malformed packets ignored, and stop() ending the presence.
 */
import * as dgram from "node:dgram";
import { afterEach, describe, expect, it } from "vitest";
import {
  FIRST_CONTACT_GROUP,
  FirstContact,
  type DiscoveredPeer,
} from "../core/first-contact.js";
import { freeLocalPort } from "./hub-helpers.js";

/** How long a test waits for a packet that should have arrived within a tick or two: generous for loopback scheduling, short enough to keep the negative cases fast. */
const PACKET_WAIT_MS = 500;
/** How long a test lets a packet that must NOT produce an effect settle before asserting the absence. */
const SETTLE_MS = 150;

const PEER_ID_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PEER_ID_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
// Arbitrary data ports the beacons carry, named so assertions read as the protocol's own vocabulary.
const DATA_PORT_A = 41001;
const DATA_PORT_B = 41002;

const openSockets: dgram.Socket[] = [];

async function testSocket(): Promise<dgram.Socket> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: "udp4" });
    socket.bind(0, () => {
      openSockets.push(socket);
      resolve(socket);
    });
  });
}

/** A socket sharing the presence's port and joined to its loopback group, which is exactly what a second real peer on the same host is: it hears every group packet the presence sends, and can send probes to the group like any peer. */
async function groupPeerSocket(port: number): Promise<dgram.Socket> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    socket.bind(port, () => {
      socket.addMembership(FIRST_CONTACT_GROUP, "127.0.0.1");
      socket.setMulticastInterface("127.0.0.1");
      socket.setMulticastLoopback(true);
      openSockets.push(socket);
      resolve(socket);
    });
  });
}

function send(socket: dgram.Socket, payload: unknown, port: number): void {
  socket.send(JSON.stringify(payload), port, "127.0.0.1");
}

async function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, SETTLE_MS);
  });
}

/** Resolves the next beacon the socket receives as parsed JSON, or undefined after PACKET_WAIT_MS. Other packets are skipped: a multicast sender hears its own probe loop back, and the waiter is after the answer to it. */
async function nextBeacon(socket: dgram.Socket): Promise<unknown> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      resolve(undefined);
    }, PACKET_WAIT_MS);
    function onMessage(msg: Buffer): void {
      try {
        const parsed: unknown = JSON.parse(msg.toString());
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "type" in parsed &&
          parsed.type === "agent-comms-beacon"
        ) {
          clearTimeout(timer);
          socket.off("message", onMessage);
          resolve(parsed);
        }
      } catch {
        // Not JSON: not a beacon either, keep waiting.
      }
    }
    socket.on("message", onMessage);
  });
}

afterEach(() => {
  for (const socket of openSockets.splice(0)) {
    socket.close();
  }
});

/** A presence on a fresh free port recording every discovery, the fixture every test starts from. */
async function startedPresence(onError?: (error: Error) => void): Promise<{
  presence: FirstContact;
  port: number;
  discovered: DiscoveredPeer[];
}> {
  const port = await freeLocalPort();
  const discovered: DiscoveredPeer[] = [];
  const presence = new FirstContact({
    peerId: PEER_ID_A,
    dataPort: DATA_PORT_A,
    name: "test-a",
    port,
    onPeerDiscovered: (peer) => {
      discovered.push({ ...peer });
    },
    ...(onError !== undefined ? { onError } : {}),
  });
  presence.start();
  return { presence, port, discovered };
}

describe("FirstContact", () => {
  it("answers a probe at once with a beacon on the group, naming its own peerId and data port", async () => {
    const { presence, port } = await startedPresence();
    const prober = await groupPeerSocket(port);
    // The presence's own start-up beacon and probe also reach this socket, so the assertion waits for a beacon that follows the probe sent here.
    await settle();
    const answer = nextBeacon(prober);

    prober.send(
      JSON.stringify({ type: "agent-comms-probe" }),
      port,
      FIRST_CONTACT_GROUP,
    );

    expect(await answer).toEqual({
      type: "agent-comms-beacon",
      peerId: PEER_ID_A,
      port: DATA_PORT_A,
      name: "test-a",
    });
    presence.stop();
  });

  it("discovers a peer from its beacon, carrying the beacon's data port and the sender's address, and deduplicates by peerId", async () => {
    const { presence, port, discovered } = await startedPresence();
    const other = await testSocket();
    const beacon = {
      type: "agent-comms-beacon",
      peerId: PEER_ID_B,
      port: DATA_PORT_B,
      name: "test-b",
    };

    send(other, beacon, port);
    await settle();
    send(other, beacon, port);
    await settle();

    expect(discovered).toEqual([
      { peerId: PEER_ID_B, host: "127.0.0.1", port: DATA_PORT_B },
    ]);
    presence.stop();
  });

  it("drops its own beacon reaching it back, by peerId", async () => {
    const { presence, port, discovered } = await startedPresence();
    const echo = await testSocket();

    send(
      echo,
      {
        type: "agent-comms-beacon",
        peerId: PEER_ID_A,
        port: DATA_PORT_A,
        name: "test-a",
      },
      port,
    );
    await settle();

    expect(discovered).toEqual([]);
    presence.stop();
  });

  it("ignores malformed packets without reporting them as errors or discoveries", async () => {
    const errors: Error[] = [];
    const { presence, port, discovered } = await startedPresence((error) => {
      errors.push(error);
    });
    const other = await testSocket();

    other.send("not json", port, "127.0.0.1");
    send(other, { type: "agent-comms-beacon" }, port);
    send(other, { type: "something-else" }, port);
    await settle();

    expect(discovered).toEqual([]);
    expect(errors).toEqual([]);
    presence.stop();
  });

  it("stops answering probes after stop()", async () => {
    const { presence, port } = await startedPresence();
    presence.stop();
    const prober = await groupPeerSocket(port);
    const answer = nextBeacon(prober);

    prober.send(
      JSON.stringify({ type: "agent-comms-probe" }),
      port,
      FIRST_CONTACT_GROUP,
    );

    expect(await answer).toBeUndefined();
  });
});

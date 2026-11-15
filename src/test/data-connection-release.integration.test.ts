/**
 * What a transport holds for a peer is released when the peer's session ends: the connection kept to send ledger frames on, and the claim of a dial. A long-running bridge meets a new peer for every agent session that starts on the machine, so anything kept per peer for ever grows without bound (agent-comms#587).
 */

import { afterEach, expect, test } from "vitest";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { DataFrameRouter } from "../core/data-frame-routing.js";
import { generateIdentity } from "../core/identity.js";
import type { Frame } from "wire-mesh-core/generated/protocol";
import type { Connection } from "wire-mesh-core/ports/transport";
import type { TransportEvents } from "../core/transport.js";
import { toIdentityPort } from "../core/wire-mesh-identity.js";
import { WireMeshTransport } from "../core/wire-mesh-transport.js";
import { freeLocalPort } from "./hub-helpers.js";
import { waitFor } from "./test-transport.js";

const SHORT_INTERVAL_MS = 30;
const DEVICE_ID_BYTES = 32;
const PEER_BYTE = 0xab;
const PEER_HEX = "ab".repeat(DEVICE_ID_BYTES);
const PING: Frame = { type: "ping" };

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
    onCoordinatorClaim: () => undefined,
    onElectionSessionEnrolled: () => undefined,
    onPresenceAdvert: () => undefined,
    onDeviceReachable: () => undefined,
  };
}

const transports: WireMeshTransport[] = [];

afterEach(async () => {
  for (const transport of transports.splice(0)) await transport.shutdown();
});

async function transportWithId(
  events: Readonly<Partial<TransportEvents>> = {},
): Promise<{
  transport: WireMeshTransport;
  hex: string;
}> {
  const identity = generateIdentity();
  const hex = deviceIdToHex(
    await toIdentityPort(identity).then((port) => port.deviceId),
  );
  const transport = new WireMeshTransport(
    { ...inertEvents(), ...events },
    identity,
    {
      presenceReadvertiseIntervalMs: SHORT_INTERVAL_MS,
    },
  );
  transports.push(transport);
  return { transport, hex };
}

async function dial(
  from: { transport: WireMeshTransport; hex: string },
  to: { transport: WireMeshTransport; hex: string },
): Promise<void> {
  await from.transport.connectToPeer(
    {
      id: to.hex,
      port: to.transport.dataPort,
      startedAt: new Date().toISOString(),
    },
    from.hex,
  );
}

function privateField(owner: object, name: string): unknown {
  return Reflect.get(owner, name);
}

test("a peer that goes away releases the connection kept for it", async () => {
  const a = await transportWithId();
  const b = await transportWithId();
  await a.transport.startDataServer();
  await b.transport.startDataServer();
  await dial(b, a);
  await waitFor(
    () => a.transport.dataFrames.heldConnections === 1,
    "A holds the connection B's frames arrived on",
  );

  await b.transport.shutdown();

  await waitFor(
    () => a.transport.dataFrames.heldConnections === 0,
    "A released the connection of the peer that left",
  );
});

test("many peers coming and going leave nothing held behind", async () => {
  const a = await transportWithId();
  await a.transport.startDataServer();
  const PEERS = 6;
  for (let index = 0; index < PEERS; index++) {
    const peer = await transportWithId();
    await peer.transport.startDataServer();
    await dial(peer, a);
    await waitFor(
      () => a.transport.dataFrames.heldConnections === 1,
      "A holds the connection of the peer that just arrived",
    );
    await peer.transport.shutdown();
    await waitFor(
      () => a.transport.dataFrames.heldConnections === 0,
      "A released it when the peer left",
    );
  }

  expect(a.transport.dataFrames.heldConnections).toBe(0);
});

test("ending an older session of a peer leaves the connection a newer session of that peer holds", async () => {
  const router = new DataFrameRouter({
    dataStorage: undefined,
    account: undefined,
    peerSessions: new Map([[PEER_HEX, {}]]),
    onError: undefined,
    hub: undefined,
    announceIntervalMs: SHORT_INTERVAL_MS,
  });
  const connectionOf = (): Connection => ({
    peerDeviceId: new Uint8Array(DEVICE_ID_BYTES).fill(PEER_BYTE),
    send: async () => Promise.resolve(),
    receive: async function* () {
      yield* [];
    },
    close: async () => Promise.resolve(),
  });
  const older = {};
  const newer = {};
  const first = connectionOf();
  const second = connectionOf();
  router.bind(older, first);
  router.bind(newer, second);
  await router.route(first, PING);
  await router.route(second, PING);

  router.release(older, PEER_HEX);
  expect(router.heldConnections).toBe(1);
  router.release(newer, PEER_HEX);
  expect(router.heldConnections).toBe(0);
  router.stop();
});

test("a session of a peer that ends does not let a second dial open beside the live one this side dialled", async () => {
  const a = await transportWithId();
  const b = await transportWithId();
  await a.transport.startDataServer();
  await b.transport.startDataServer();
  await dial(a, b);
  await dial(b, a);
  const dials = privateField(a.transport, "dataDials");
  const sessions = privateField(a.transport, "allSessions");
  if (!(dials instanceof Map) || !(sessions instanceof Set)) {
    throw new Error("the transport's bookkeeping is not where the test looks");
  }
  await waitFor(
    () => sessions.size === 2,
    "A has a dialled and an accepted session",
  );
  const dialled: unknown = dials.get(b.hex);
  const accepted = [...sessions].find((session) => session !== dialled) as
    { close: () => Promise<void> } | undefined;
  if (dialled === undefined || accepted === undefined) {
    throw new Error("expected both a dialled and an accepted session");
  }

  await accepted.close();
  await waitFor(() => sessions.size === 1, "A forgot the accepted session");

  expect(dials.get(b.hex)).toBe(dialled);
  const before = sessions.size;
  await dial(a, b);
  expect(sessions.size).toBe(before);
});

test("a failed dial to a peer that is connected through another session does not report it unreachable", async () => {
  const unreachable: string[] = [];
  const a = await transportWithId({
    onPeerUnreachable: (peer) => void unreachable.push(peer.id),
  });
  const b = await transportWithId();
  await a.transport.startDataServer();
  await b.transport.startDataServer();
  // B reaches A: A holds an accepted session with B and has dialled nothing.
  await dial(b, a);
  await waitFor(
    () => a.transport.dataFrames.heldConnections === 1,
    "A holds an accepted session with B",
  );
  const deadPort = await freeLocalPort();

  await a.transport.connectToPeer(
    { id: b.hex, port: deadPort, startedAt: new Date().toISOString() },
    a.hex,
  );

  expect(unreachable).toEqual([]);
});

test("a failed dial to a peer with no live session is reported unreachable", async () => {
  const unreachable: string[] = [];
  const a = await transportWithId({
    onPeerUnreachable: (peer) => void unreachable.push(peer.id),
  });
  await a.transport.startDataServer();
  const deadPort = await freeLocalPort();

  await a.transport.connectToPeer(
    {
      id: "never-connected",
      port: deadPort,
      startedAt: new Date().toISOString(),
    },
    a.hex,
  );

  expect(unreachable).toEqual(["never-connected"]);
});

test("ending the session that last carried a frame hands the peer's connection to the session that is still open", async () => {
  const router = new DataFrameRouter({
    dataStorage: undefined,
    account: undefined,
    peerSessions: new Map([[PEER_HEX, {}]]),
    onError: undefined,
    hub: undefined,
    announceIntervalMs: SHORT_INTERVAL_MS,
  });
  const connectionOf = (): Connection => ({
    peerDeviceId: new Uint8Array(DEVICE_ID_BYTES).fill(PEER_BYTE),
    send: async () => Promise.resolve(),
    receive: async function* () {
      yield* [];
    },
    close: async () => Promise.resolve(),
  });
  const dialled = {};
  const accepted = {};
  const dialledConnection = connectionOf();
  const acceptedConnection = connectionOf();
  router.bind(dialled, dialledConnection);
  router.bind(accepted, acceptedConnection);
  await router.route(dialledConnection, PING);
  const sent: string[] = [];
  Reflect.set(acceptedConnection, "send", async () => {
    sent.push("accepted");
  });

  router.release(dialled, PEER_HEX);

  expect(router.heldConnections).toBe(1);
  await router.send(PEER_HEX, { type: "data-have" } as never);
  expect(sent).toEqual(["accepted"]);
  router.release(accepted, PEER_HEX);
  expect(router.heldConnections).toBe(0);
  router.stop();
});

test("a frame that was in flight when its session ended does not put the connection back", async () => {
  const router = new DataFrameRouter({
    dataStorage: undefined,
    account: undefined,
    peerSessions: new Map([[PEER_HEX, {}]]),
    onError: undefined,
    hub: undefined,
    announceIntervalMs: SHORT_INTERVAL_MS,
  });
  const connection: Connection = {
    peerDeviceId: new Uint8Array(DEVICE_ID_BYTES).fill(PEER_BYTE),
    send: async () => Promise.resolve(),
    receive: async function* () {
      yield* [];
    },
    close: async () => Promise.resolve(),
  };
  const session = {};
  router.bind(session, connection);
  await router.route(connection, PING);
  expect(router.heldConnections).toBe(1);

  router.release(session, PEER_HEX);
  await router.route(connection, PING);

  expect(router.heldConnections).toBe(0);
  router.stop();
});

test("a connection that was never admitted is not recorded", async () => {
  const router = new DataFrameRouter({
    dataStorage: undefined,
    account: undefined,
    peerSessions: new Map([[PEER_HEX, {}]]),
    onError: undefined,
    hub: undefined,
    announceIntervalMs: SHORT_INTERVAL_MS,
  });
  const connection: Connection = {
    peerDeviceId: new Uint8Array(DEVICE_ID_BYTES).fill(PEER_BYTE),
    send: async () => Promise.resolve(),
    receive: async function* () {
      yield* [];
    },
    close: async () => Promise.resolve(),
  };

  await router.route(connection, PING);

  expect(router.heldConnections).toBe(0);
  router.stop();
});

test("a request to a gateway that fails leaves nothing held for the session it opened", async () => {
  const { transport } = await transportWithId();
  const connection: Connection = {
    peerDeviceId: new Uint8Array(DEVICE_ID_BYTES).fill(PEER_BYTE),
    send: async () => Promise.resolve(),
    receive: async function* () {
      yield* [];
    },
    close: async () => Promise.resolve(),
  };
  let closed = 0;
  const session = {
    sendManageRequest: async () => Promise.reject(new Error("no answer")),
    close: async () => {
      closed += 1;
    },
  };
  Reflect.set(transport, "wireTransport", {
    connect: async () => Promise.resolve(connection),
  });
  Reflect.set(transport, "openSession", async () => {
    transport.dataFrames.bind(session, connection);
    await transport.dataFrames.route(connection, PING);
    return session;
  });

  await expect(
    transport.connectToRemote({
      host: "127.0.0.1",
      port: 1,
      peerId: "p",
      dataPort: 1,
      name: "n",
      fingerprint: "f",
    }),
  ).rejects.toThrow("no answer");

  expect(closed).toBe(1);
  expect(transport.dataFrames.heldConnections).toBe(0);
});

test("a connection whose session never opens is not left recorded by a frame that arrived while it was opening", async () => {
  const router = new DataFrameRouter({
    dataStorage: undefined,
    account: undefined,
    peerSessions: new Map([[PEER_HEX, {}]]),
    onError: undefined,
    hub: undefined,
    announceIntervalMs: SHORT_INTERVAL_MS,
  });
  const connection: Connection = {
    peerDeviceId: new Uint8Array(DEVICE_ID_BYTES).fill(PEER_BYTE),
    send: async () => Promise.resolve(),
    receive: async function* () {
      yield* [];
    },
    close: async () => Promise.resolve(),
  };

  await expect(
    router.admitting(connection, async () => {
      await router.route(connection, PING);
      expect(router.heldConnections).toBe(1);
      throw new Error("the handshake failed");
    }),
  ).rejects.toThrow("the handshake failed");

  expect(router.heldConnections).toBe(0);
  router.stop();
});

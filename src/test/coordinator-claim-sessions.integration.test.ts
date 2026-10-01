/**
 * Which sessions a store accepts coordinator claims from, and announces its own over (agent-comms#341), against real sockets. A claim is a bid for this machine's coordinator duties, so it may only come from a trusted session to a peer on this machine: never from a session that may cross machines (an addListener listener, a connectToRemote dial, a data dial at an address other than a loopback one), and never from a session on the well-known port before it has introduced itself. A hand-built peer on the far end of each session sends a claim at a term above the store's own, so an accepted claim would visibly replace the store's; a manage-request sent after the claim over the same session, and answered, proves the store has read the claim before the test looks at its state.
 */

import * as os from "node:os";
import { test, expect } from "vitest";
import { createTlsTransport } from "wire-mesh-core/adapters/tls-transport";
import {
  acceptMeshSession,
  type AcceptedMeshSession,
} from "wire-mesh-core/domain/mesh-session";
import {
  deviceIdFromHex,
  deviceIdToHex,
} from "wire-mesh-core/domain/device-id";
import type { CoordinatorFrame } from "wire-mesh-core/generated/protocol";
import type { Connection } from "wire-mesh-core/ports/transport";
import { generateIdentity } from "../core/identity.js";
import { listenerPort } from "../core/listener-registry.js";
import { MeshStore } from "../core/mesh-store.js";
import {
  DOMAIN,
  FRAME_SCOPE,
  buildCommand,
} from "../core/wire-mesh-transport.js";
import { toIdentityPort } from "../core/wire-mesh-identity.js";
import { TeardownStack, freeLocalPort } from "./hub-helpers.js";
import { wireTestTransport } from "./test-transport.js";

/** Above the term 0 a lone store claims at, so accepting this claim would supersede the store's own. */
const ROGUE_TERM = 7;

interface RawPeer {
  deviceHex: string;
  identity: ReturnType<typeof generateIdentity>;
  transport: ReturnType<typeof createTlsTransport>;
}

function rawPeer(): RawPeer {
  const identity = generateIdentity();
  return {
    deviceHex: deviceIdToHex(Uint8Array.from(identity.deviceId)),
    identity,
    transport: createTlsTransport({
      certificatePem: identity.certificate,
      privateKeyPem: identity.privateKey,
    }),
  };
}

async function openSession(
  peer: Readonly<RawPeer>,
  connection: Readonly<Connection>,
  teardown: TeardownStack,
): Promise<AcceptedMeshSession> {
  const session = await acceptMeshSession(
    connection,
    await toIdentityPort(peer.identity),
    [DOMAIN],
  );
  teardown.push(async () => {
    await session.close();
  });
  return session;
}

async function dialAsRawPeer(
  peer: Readonly<RawPeer>,
  port: number,
  teardown: TeardownStack,
): Promise<AcceptedMeshSession> {
  const connection = await peer.transport.connect(`127.0.0.1:${String(port)}`);
  return openSession(peer, connection, teardown);
}

/** A lone store on its own well-known port, holding the role at term 0 as it claims when nothing else could reach it. */
async function startLoneHolder(teardown: TeardownStack): Promise<MeshStore> {
  const store = new MeshStore({ coordinatorPort: await freeLocalPort() });
  await wireTestTransport(store);
  teardown.push(async () => {
    await store.shutdown();
  });
  await store.init();
  expect(store.coordinatorClaim).toEqual({ term: 0, holder: store.peerId });
  return store;
}

function rogueClaim(holderHex: string): CoordinatorFrame {
  return {
    type: "coordinator",
    term: ROGUE_TERM,
    coordinator: deviceIdFromHex(holderHex),
  };
}

/** Sends a request the store answers once it has read everything sent before it on this session. */
async function roundTrip(session: AcceptedMeshSession): Promise<void> {
  const outcome = await session.sendManageRequest(
    buildCommand({ method: "peer_list", peers: [] }),
    FRAME_SCOPE,
  );
  expect(outcome.result).toBe("ok");
}

async function introduce(
  session: AcceptedMeshSession,
  peer: Readonly<RawPeer>,
): Promise<void> {
  // Nothing listens on this port, so the store's dial back at the raw peer's data server fails, which none of these tests depend on.
  const dataPort = await freeLocalPort();
  const outcome = await session.sendManageRequest(
    buildCommand({ method: "introduce", peerId: peer.deviceHex, dataPort }),
    FRAME_SCOPE,
  );
  expect(outcome.result).toBe("ok");
}

async function firstCoordinatorFrame(
  session: AcceptedMeshSession,
): Promise<CoordinatorFrame> {
  for await (const frame of session.coordinatorFrames) return frame;
  throw new Error("the session ended before any coordinator-frame arrived");
}

test("a claim from a peer introduced on the well-known port is accepted", async () => {
  const teardown = new TeardownStack();
  try {
    const store = await startLoneHolder(teardown);
    const peer = rawPeer();
    const session = await dialAsRawPeer(peer, store.coordinatorPort, teardown);

    await introduce(session, peer);
    await session.sendCoordinatorClaim(rogueClaim(peer.deviceHex));
    await roundTrip(session);

    expect(store.coordinatorClaim).toEqual({
      term: ROGUE_TERM,
      holder: peer.deviceHex,
    });
    expect(store.holdsCoordinatorRole).toBe(false);
  } finally {
    await teardown.run();
  }
});

test("a claim sent on the well-known port before introduce is dropped, and the peer is told the incumbent once it introduces itself", async () => {
  const teardown = new TeardownStack();
  try {
    const store = await startLoneHolder(teardown);
    const peer = rawPeer();
    const session = await dialAsRawPeer(peer, store.coordinatorPort, teardown);
    const announced = firstCoordinatorFrame(session);

    await session.sendCoordinatorClaim(rogueClaim(peer.deviceHex));
    await introduce(session, peer);
    await roundTrip(session);

    expect(store.coordinatorClaim).toEqual({ term: 0, holder: store.peerId });
    expect(store.holdsCoordinatorRole).toBe(true);
    expect(await announced).toEqual({
      type: "coordinator",
      term: 0,
      coordinator: deviceIdFromHex(store.peerId),
    });
  } finally {
    await teardown.run();
  }
});

test("a claim from a peer introduced on an addListener listener is dropped, since that listener may be reached from another machine", async () => {
  const teardown = new TeardownStack();
  try {
    const store = await startLoneHolder(teardown);
    const listenerId = await store.addListener("127.0.0.1", 0, "full");
    const listener = store
      .listListeners()
      .find((entry) => entry.id === listenerId);
    if (listener === undefined) throw new Error("expected the added listener");
    const peer = rawPeer();
    const session = await dialAsRawPeer(peer, listener.port, teardown);

    await introduce(session, peer);
    await session.sendCoordinatorClaim(rogueClaim(peer.deviceHex));
    await roundTrip(session);

    expect(store.coordinatorClaim).toEqual({ term: 0, holder: store.peerId });
    expect(store.holdsCoordinatorRole).toBe(true);
  } finally {
    await teardown.run();
  }
});

test("a claim from the far end of a connectToRemote dial is dropped, since that dial may reach another machine", async () => {
  const teardown = new TeardownStack();
  try {
    const store = await startLoneHolder(teardown);
    const peer = rawPeer();
    const accepted = new Promise<AcceptedMeshSession>((resolve, reject) => {
      void peer.transport
        .listen("127.0.0.1:0", (connection) => {
          openSession(peer, connection, teardown).then(resolve, reject);
        })
        .then(async (listener) => {
          teardown.push(async () => {
            await listener.close();
          });
          await store.connectToRemote("127.0.0.1", listenerPort(listener));
        })
        .catch(reject);
    });
    const session = await accepted;
    for await (const request of session.incomingManageRequests) {
      // The dial's connect_request, answered as an approving operator would.
      await request.respond({ result: "ok" });
      break;
    }
    // Answered only once the store is reading this session, so the claim below cannot arrive before the store has decided whether to enrol it.
    await roundTrip(session);

    await session.sendCoordinatorClaim(rogueClaim(peer.deviceHex));
    await roundTrip(session);

    expect(store.coordinatorClaim).toEqual({ term: 0, holder: store.peerId });
    expect(store.holdsCoordinatorRole).toBe(true);
  } finally {
    await teardown.run();
  }
});

test("a store that dials a peer's data server tells it the incumbent, not only the side that accepted", async () => {
  const teardown = new TeardownStack();
  try {
    const store = await startLoneHolder(teardown);
    const peer = rawPeer();
    const accepted = new Promise<AcceptedMeshSession>((resolve, reject) => {
      void peer.transport
        .listen("127.0.0.1:0", (connection) => {
          openSession(peer, connection, teardown).then(resolve, reject);
        })
        .then((listener) => {
          teardown.push(async () => {
            await listener.close();
          });
          store.events.onPeerList([
            {
              id: peer.deviceHex,
              port: listenerPort(listener),
              startedAt: new Date().toISOString(),
            },
          ]);
        })
        .catch(reject);
    });
    const session = await accepted;

    expect(await firstCoordinatorFrame(session)).toEqual({
      type: "coordinator",
      term: 0,
      coordinator: deviceIdFromHex(store.peerId),
    });
  } finally {
    await teardown.run();
  }
});

/** An address of this machine's own that is not a loopback one, so a dial at it reaches a listener here while naming an address another machine on the LAN could equally hold. */
function nonLoopbackAddress(): string {
  const address = Object.values(os.networkInterfaces())
    .flat()
    .find((entry) => entry?.family === "IPv4" && !entry.internal);
  if (address === undefined) {
    throw new Error(
      "this test needs a non-loopback IPv4 interface to dial a listener through",
    );
  }
  return address.address;
}

/** Has the store dial a raw peer's listener at the given host through the ordinary peer-list path (the one first contact feeds discovered peers into), returning the raw peer's end of the session once the store is reading it. */
async function dialedByStore(
  store: MeshStore,
  peer: Readonly<RawPeer>,
  host: string,
  teardown: TeardownStack,
): Promise<AcceptedMeshSession> {
  const session = await new Promise<AcceptedMeshSession>((resolve, reject) => {
    void peer.transport
      .listen("0.0.0.0:0", (connection) => {
        openSession(peer, connection, teardown).then(resolve, reject);
      })
      .then((listener) => {
        teardown.push(async () => {
          await listener.close();
        });
        store.events.onPeerList([
          {
            id: peer.deviceHex,
            host,
            port: listenerPort(listener),
            startedAt: new Date().toISOString(),
          },
        ]);
      })
      .catch(reject);
  });
  // Answered only once the store is reading this session, so the claim the caller sends next cannot arrive before the store has decided whether to enrol it.
  await roundTrip(session);
  return session;
}

test("a claim over a data dial at a non-loopback address is dropped, since that address may belong to another machine on the LAN", async () => {
  const teardown = new TeardownStack();
  try {
    const store = await startLoneHolder(teardown);
    const peer = rawPeer();
    const session = await dialedByStore(
      store,
      peer,
      nonLoopbackAddress(),
      teardown,
    );

    await session.sendCoordinatorClaim(rogueClaim(peer.deviceHex));
    await roundTrip(session);

    expect(store.coordinatorClaim).toEqual({ term: 0, holder: store.peerId });
    expect(store.holdsCoordinatorRole).toBe(true);
  } finally {
    await teardown.run();
  }
});

test("a claim over a data dial at a loopback address is accepted", async () => {
  const teardown = new TeardownStack();
  try {
    const store = await startLoneHolder(teardown);
    const peer = rawPeer();
    const session = await dialedByStore(store, peer, "127.0.0.1", teardown);

    await session.sendCoordinatorClaim(rogueClaim(peer.deviceHex));
    await roundTrip(session);

    expect(store.coordinatorClaim).toEqual({
      term: ROGUE_TERM,
      holder: peer.deviceHex,
    });
    expect(store.holdsCoordinatorRole).toBe(false);
  } finally {
    await teardown.run();
  }
});

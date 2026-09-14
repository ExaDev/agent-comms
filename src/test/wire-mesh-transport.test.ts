/**
 * Direct WireMeshTransport tests, constructed against two real WireMeshTransport instances joined by genuine TLS sessions (no MeshStore, no mocked session layer) -- the same pattern presence-readvertise.integration.test.ts already uses, chosen here for the same reason: raw access to TransportEvents callbacks and the public MeshTransport surface gives tighter causal control than going through MeshStore's own higher-level state machine.
 */

import * as net from "node:net";
import { test, describe, expect, vi } from "vitest";
import { createTlsTransport } from "wire-mesh-core/adapters/tls-transport";
import { acceptMeshSession } from "wire-mesh-core/domain/mesh-session";
import { generateIdentity } from "../core/identity.js";
import { toIdentityPort } from "../core/wire-mesh-identity.js";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import {
  WireMeshTransport,
  DOMAIN,
  FRAME_VERB,
  FRAME_SCOPE,
  buildCommand,
} from "../core/wire-mesh-transport.js";
import type {
  ConnectionHandle,
  TransportEvents,
  ListenerPolicy,
} from "../core/transport.js";
import type { MeshMessage } from "../core/wire-protocol.js";
import { waitFor } from "./test-transport.js";

function noopEvents(overrides: Partial<TransportEvents> = {}): TransportEvents {
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
    ...overrides,
  };
}

/** Finds a free localhost port by binding to port 0 and immediately releasing it -- used both for uniquePort()-style allocation and, when nothing is subsequently listened on it, as a guaranteed-refused dial target. */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function peerId(identity: { deviceId: Uint8Array }): Promise<string> {
  // Uint8Array.from(...) normalises identity.deviceId's own ArrayBufferLike-backed type to the plain ArrayBuffer-backed Uint8Array deviceIdToHex expects -- the same normalisation test-transport.ts's own wireTestTransport already applies for the identical reason.
  return deviceIdToHex(Uint8Array.from(identity.deviceId));
}

describe("WireMeshTransport wire-level constants", () => {
  test("DOMAIN and FRAME_SCOPE carry the documented, registered namespaced values", () => {
    // These are the values this transport actually authenticates and scopes every manage-request against -- not implementation detail, but the wire contract itself (see this file's own header comment and registry/core-domains.md's "<registrant>/<local-name>" convention). A test importing them and asserting their literal value catches drift that a test which merely re-imports the same binding on both sides of a handshake cannot: both sides of such a test would agree on a mutated value symmetrically and never notice.
    expect(DOMAIN).toBe("exadev.io/agent-comms-v1");
    expect(FRAME_SCOPE).toEqual({ kind: "agent-comms-mesh" });
  });

  test("buildCommand wraps a MeshMessage as the single FRAME_VERB command's opaque payload", () => {
    const message: MeshMessage = { method: "peer_left", peerId: "abc123" };
    expect(buildCommand(message)).toEqual({
      verb: FRAME_VERB,
      params: { message },
    });
  });
});

describe("WireMeshTransport presence-interval construction", () => {
  test("no presence source configured never starts the readvertise interval", () => {
    const identity = generateIdentity();
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    try {
      new WireMeshTransport(noopEvents(), identity);
      expect(setIntervalSpy).not.toHaveBeenCalled();
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  test("a presence source configured starts exactly one unref'd readvertise interval at the documented default cadence (20 seconds)", () => {
    const identity = generateIdentity();
    const unrefSpy = vi.fn();
    const fakeTimer = { unref: unrefSpy } as unknown as NodeJS.Timeout;
    const setIntervalSpy = vi
      .spyOn(global, "setInterval")
      .mockReturnValue(fakeTimer);
    try {
      new WireMeshTransport(
        noopEvents(),
        identity,
        undefined,
        undefined,
        () => "active",
        // Deliberately omitted: relying on the constructor's own default presenceReadvertiseIntervalMs argument is the point of this test -- it proves PRESENCE_READVERTISE_INTERVAL_SECONDS * MS_PER_SECOND actually computes 20_000, not merely that *some* interval gets scheduled.
      );
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(setIntervalSpy.mock.calls[0]?.[1]).toBe(20_000);
      expect(unrefSpy).toHaveBeenCalledTimes(1);
    } finally {
      setIntervalSpy.mockRestore();
    }
  });
});

describe("WireMeshTransport coordinator/getter state", () => {
  test("isCoordinator starts false and flips true once becomeCoordinator has bound its listener", async () => {
    const identity = generateIdentity();
    const transport = new WireMeshTransport(noopEvents(), identity);
    try {
      expect(transport.isCoordinator).toBe(false);
      await transport.becomeCoordinator("127.0.0.1", 0);
      expect(transport.isCoordinator).toBe(true);
    } finally {
      await transport.shutdown();
    }
  });

  test("hasCoordinatorConnection starts false and flips true once connectToCoordinator establishes its session", async () => {
    const identityA = generateIdentity();
    const identityB = generateIdentity();
    const idA = await peerId(await toIdentityPort(identityA));
    const idB = await peerId(await toIdentityPort(identityB));

    const transportA = new WireMeshTransport(noopEvents(), identityA);
    const disconnects: ConnectionHandle[] = [];
    const transportB = new WireMeshTransport(
      noopEvents({ onPeerDisconnected: (h) => disconnects.push(h) }),
      identityB,
    );
    try {
      await transportA.becomeCoordinator("127.0.0.1", 0);
      const [listener] = transportA.listListeners();
      if (listener === undefined) throw new Error("expected a bound listener");

      expect(transportB.hasCoordinatorConnection).toBe(false);
      await transportB.connectToCoordinator("127.0.0.1", listener.port, idB, 0);
      expect(transportB.hasCoordinatorConnection).toBe(true);

      // connectToCoordinator also wires watchForDisconnect for this session (WireMeshTransport, "MeshTransport -- Coordinator connection"): tearing down the coordinator's own side must surface as onPeerDisconnected on B, proving that wiring actually happened rather than only the session being tracked.
      await transportA.shutdown();
      await waitFor(
        () => disconnects.some((h) => h.id === idA),
        "B observes the coordinator's disconnection",
      );
    } finally {
      await transportB.shutdown();
    }
  });
});

describe("WireMeshTransport connect_request quarantine and disconnect handling", () => {
  test("a requester disconnecting before a human decides clears the pending entry without firing onPeerDisconnected", async () => {
    const identityA = generateIdentity();
    const identityB = generateIdentity();
    const idB = await peerId(await toIdentityPort(identityB));

    const disconnectsSeenByA: ConnectionHandle[] = [];
    const requestsSeenByA: ConnectionHandle[] = [];
    const transportA = new WireMeshTransport(
      noopEvents({
        onConnectionRequest: (handle) => requestsSeenByA.push(handle),
        onPeerDisconnected: (handle) => disconnectsSeenByA.push(handle),
      }),
      identityA,
    );
    try {
      await transportA.becomeCoordinator("127.0.0.1", 0);
      const [listener] = transportA.listListeners();
      if (listener === undefined) throw new Error("expected a bound listener");

      // Built directly against the raw session rather than via transportB.connectToRemote(): connectToRemote only calls trackSession (which is what shutdown()'s own allSessions loop would later close) once its sendManageRequest resolves -- and by design here it never does, since A holds the request open pending a human decision. Controlling the session directly lets this test close exactly that still-pending connection itself, deterministically, rather than relying on a transport-level shutdown() that can't reach an untracked in-flight session.
      const clientTransport = createTlsTransport({
        certificatePem: identityB.certificate,
        privateKeyPem: identityB.privateKey,
      });
      const connection = await clientTransport.connect(
        `127.0.0.1:${String(listener.port)}`,
      );
      const clientIdentityPort = await toIdentityPort(identityB);
      const session = await acceptMeshSession(connection, clientIdentityPort, [
        DOMAIN,
      ]);
      void session
        .sendManageRequest(
          buildCommand({
            method: "connect_request",
            peerId: idB,
            dataPort: 0,
            name: "connector",
            fingerprint: "",
          }),
          FRAME_SCOPE,
        )
        .catch(() => undefined);

      await waitFor(
        () => requestsSeenByA.some((h) => h.id === idB),
        "A observes the pending connect_request",
      );
      const handle = requestsSeenByA.find((h) => h.id === idB);
      if (handle === undefined) throw new Error("expected the request handle");

      // The requester disconnects abruptly, before A ever calls acceptConnection/rejectConnection.
      await session.close();

      // No positive event to poll for here (the assertion below proves an absence), so a fixed wait is the right shape, matching approval.integration.test.ts's own "reject closes with reason" convention -- long enough for A's watchForDisconnect handler to have processed the closed session event.
      await new Promise((resolve) => setTimeout(resolve, 300));

      // The strongest available proof the pending entry was actually cleaned up (not merely "not yet decided", which would be equally true before disconnect too): a decision made afterwards must fail exactly like it does for any other unknown handle.
      await expect(
        transportA.rejectConnection(handle, "too late"),
      ).rejects.toThrow(/No pending connection/);

      // wasTracked is false for a session that never got past quarantine (trackSession is only ever called from the introduce/connect_request-approved paths) -- A must not report a peer disconnection for a peer it never actually tracked as connected.
      expect(disconnectsSeenByA.some((h) => h.id === idB)).toBe(false);
    } finally {
      await transportA.shutdown();
    }
  });

  test("acceptConnection and rejectConnection each remove their own pending entry exactly once -- a second decision on the same handle fails like any unknown handle", async () => {
    const identityA = generateIdentity();
    const identityB = generateIdentity();
    const identityC = generateIdentity();
    const idB = await peerId(await toIdentityPort(identityB));
    const idC = await peerId(await toIdentityPort(identityC));

    const requests: ConnectionHandle[] = [];
    const transportA = new WireMeshTransport(
      noopEvents({ onConnectionRequest: (h) => requests.push(h) }),
      identityA,
    );
    const transportB = new WireMeshTransport(noopEvents(), identityB);
    const transportC = new WireMeshTransport(noopEvents(), identityC);
    try {
      await transportA.becomeCoordinator("127.0.0.1", 0);
      const [listener] = transportA.listListeners();
      if (listener === undefined) throw new Error("expected a bound listener");

      void transportB
        .connectToRemote("127.0.0.1", listener.port, idB, 0, "b", "")
        .catch(() => undefined);
      void transportC
        .connectToRemote("127.0.0.1", listener.port, idC, 0, "c", "")
        .catch(() => undefined);

      await waitFor(
        () =>
          requests.some((h) => h.id === idB) &&
          requests.some((h) => h.id === idC),
        "A observes both pending connect_requests",
      );
      const handleB = requests.find((h) => h.id === idB);
      const handleC = requests.find((h) => h.id === idC);
      if (handleB === undefined || handleC === undefined) {
        throw new Error("expected both request handles");
      }

      await transportA.acceptConnection(handleB);
      await expect(transportA.acceptConnection(handleB)).rejects.toThrow(
        /No pending connection/,
      );

      await transportA.rejectConnection(handleC, "no thanks");
      await expect(
        transportA.rejectConnection(handleC, "no thanks again"),
      ).rejects.toThrow(/No pending connection/);
    } finally {
      await transportC.shutdown();
      await transportB.shutdown();
      await transportA.shutdown();
    }
  });

  test("connectToRemote rejects with the coordinator's own rejection message, even when it's the empty string, and never establishes a session", async () => {
    const identityA = generateIdentity();
    const identityB = generateIdentity();
    const idA = await peerId(await toIdentityPort(identityA));
    const idB = await peerId(await toIdentityPort(identityB));

    const requests: ConnectionHandle[] = [];
    const messagesSeenByA: MeshMessage[] = [];
    const transportA = new WireMeshTransport(
      noopEvents({
        onConnectionRequest: (h) => requests.push(h),
        onMessage: (_h, m) => messagesSeenByA.push(m),
      }),
      identityA,
    );
    const transportB = new WireMeshTransport(noopEvents(), identityB);
    try {
      await transportA.becomeCoordinator("127.0.0.1", 0);
      const [listener] = transportA.listListeners();
      if (listener === undefined) throw new Error("expected a bound listener");

      const connectPromise = transportB.connectToRemote(
        "127.0.0.1",
        listener.port,
        idB,
        0,
        "b",
        "",
      );

      await waitFor(
        () => requests.some((h) => h.id === idB),
        "A observes the pending connect_request",
      );
      const handle = requests.find((h) => h.id === idB);
      if (handle === undefined) throw new Error("expected the request handle");

      // An empty-string reason distinguishes `outcome.message ?? outcome.code` (keeps "") from `outcome.message || outcome.code` (would fall through to "rejected") -- a non-empty reason can't tell these apart, since both operators agree on any truthy string.
      await transportA.rejectConnection(handle, "");
      await expect(connectPromise).rejects.toThrow(/^$/);

      // The rejected side must never be left with a working session: sending a message under A's own real device id -- the only id a real session to A could ever be tracked under -- must be a silent no-op, since connectToRemote's own rejection path returns before trackSession/consumeIncoming ever run.
      await transportB
        .send({ id: idA }, { method: "peer_left", peerId: "nobody" })
        .catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(messagesSeenByA.length).toBe(0);
    } finally {
      await transportB.shutdown();
      await transportA.shutdown();
    }
  });

  test("connectToRemote establishes a fully working, bidirectional session once accepted", async () => {
    const identityA = generateIdentity();
    const identityB = generateIdentity();
    const idA = await peerId(await toIdentityPort(identityA));
    const idB = await peerId(await toIdentityPort(identityB));

    const requests: ConnectionHandle[] = [];
    const messagesSeenByA: MeshMessage[] = [];
    const messagesSeenByB: MeshMessage[] = [];
    const transportA = new WireMeshTransport(
      noopEvents({
        onConnectionRequest: (h) => requests.push(h),
        onMessage: (_h, m) => messagesSeenByA.push(m),
      }),
      identityA,
    );
    const transportB = new WireMeshTransport(
      noopEvents({ onMessage: (_h, m) => messagesSeenByB.push(m) }),
      identityB,
    );
    try {
      await transportA.becomeCoordinator("127.0.0.1", 0);
      const [listener] = transportA.listListeners();
      if (listener === undefined) throw new Error("expected a bound listener");

      const connectPromise = transportB.connectToRemote(
        "127.0.0.1",
        listener.port,
        idB,
        0,
        "b",
        "",
      );

      await waitFor(
        () => requests.some((h) => h.id === idB),
        "A observes the pending connect_request",
      );
      const handle = requests.find((h) => h.id === idB);
      if (handle === undefined) throw new Error("expected the request handle");

      await transportA.acceptConnection(handle);
      await connectPromise;

      await transportA.send(
        { id: idB },
        { method: "peer_left", peerId: "from-a" },
      );
      await waitFor(
        () =>
          messagesSeenByB.some(
            (m) => m.method === "peer_left" && m.peerId === "from-a",
          ),
        "B receives A's message over the accepted session",
      );

      await transportB.send(
        { id: idA },
        { method: "peer_left", peerId: "from-b" },
      );
      await waitFor(
        () =>
          messagesSeenByA.some(
            (m) => m.method === "peer_left" && m.peerId === "from-b",
          ),
        "A receives B's message over the accepted session",
      );
    } finally {
      await transportB.shutdown();
      await transportA.shutdown();
    }
  });
});

describe("WireMeshTransport connectToPeer", () => {
  test("connectToPeer establishes a working session that can exchange messages in both directions", async () => {
    const identityA = generateIdentity();
    const identityB = generateIdentity();
    const idA = await peerId(await toIdentityPort(identityA));
    const idB = await peerId(await toIdentityPort(identityB));

    const messagesSeenByA: MeshMessage[] = [];
    const messagesSeenByB: MeshMessage[] = [];
    const transportA = new WireMeshTransport(
      noopEvents({ onMessage: (_h, m) => messagesSeenByA.push(m) }),
      identityA,
    );
    const transportB = new WireMeshTransport(
      noopEvents({ onMessage: (_h, m) => messagesSeenByB.push(m) }),
      identityB,
    );
    try {
      await transportA.startDataServer();
      await transportB.connectToPeer(
        {
          id: idA,
          port: transportA.dataPort,
          startedAt: new Date().toISOString(),
        },
        idB,
      );

      await transportB.send(
        { id: idA },
        { method: "peer_left", peerId: "from-b" },
      );
      await waitFor(
        () =>
          messagesSeenByA.some(
            (m) => m.method === "peer_left" && m.peerId === "from-b",
          ),
        "A receives B's message over the peer-to-peer session",
      );

      await transportA.send(
        { id: idB },
        { method: "peer_left", peerId: "from-a" },
      );
      await waitFor(
        () =>
          messagesSeenByB.some(
            (m) => m.method === "peer_left" && m.peerId === "from-a",
          ),
        "B receives A's message over the peer-to-peer session",
      );
    } finally {
      await transportB.shutdown();
      await transportA.shutdown();
    }
  });

  test("connectToPeer refuses and reports an error when the far side authenticates as a different device id than claimed", async () => {
    const identityA = generateIdentity();
    const identityB = generateIdentity();
    const idA = await peerId(await toIdentityPort(identityA));

    const errors: Error[] = [];
    const transportA = new WireMeshTransport(noopEvents(), identityA);
    const transportB = new WireMeshTransport(
      noopEvents({ onError: (e) => errors.push(e) }),
      identityB,
    );
    try {
      await transportA.startDataServer();
      const claimedId = "0".repeat(idA.length);
      await transportB.connectToPeer(
        {
          id: claimedId,
          port: transportA.dataPort,
          startedAt: new Date().toISOString(),
        },
        "self",
      );

      await waitFor(
        () => errors.some((e) => e.message.includes("expected")),
        "B reports the device-id mismatch",
      );
      const error = errors.find((e) => e.message.includes("expected"));
      expect(error?.message).toContain(claimedId);
      expect(error?.message).toContain(idA);
    } finally {
      await transportB.shutdown();
      await transportA.shutdown();
    }
  });

  test("connectToPeer reports a wrapped, descriptive error via onError when the dial itself fails", async () => {
    const identityB = generateIdentity();
    const errors: Error[] = [];
    const transportB = new WireMeshTransport(
      noopEvents({ onError: (e) => errors.push(e) }),
      identityB,
    );
    try {
      const deadPort = await findFreePort();
      await transportB.connectToPeer(
        {
          id: "unreachable-peer",
          port: deadPort,
          startedAt: new Date().toISOString(),
        },
        "self",
      );

      await waitFor(
        () => errors.length > 0,
        "B reports the failed dial via onError",
      );
      expect(errors[0]?.message).toContain("connectToPeer");
      expect(errors[0]?.message).toContain("unreachable-peer");
      expect(errors[0]?.message).toContain(String(deadPort));
    } finally {
      await transportB.shutdown();
    }
  });
});

describe("WireMeshTransport shutdown", () => {
  test("shutdown clears the presence interval, rejects every pending connect_request with shutting_down, and closes every tracked and quarantined session", async () => {
    const identityA = generateIdentity();
    const identityB = generateIdentity();
    const idB = await peerId(await toIdentityPort(identityB));

    const requests: ConnectionHandle[] = [];
    const transportA = new WireMeshTransport(
      noopEvents({ onConnectionRequest: (h) => requests.push(h) }),
      identityA,
      undefined,
      undefined,
      () => "active",
    );
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");
    const transportB = new WireMeshTransport(noopEvents(), identityB);
    try {
      await transportA.becomeCoordinator("127.0.0.1", 0);
      const [listener] = transportA.listListeners();
      if (listener === undefined) throw new Error("expected a bound listener");

      const connectPromise = transportB
        .connectToRemote("127.0.0.1", listener.port, idB, 0, "b", "")
        .catch((e: unknown) => e);

      await waitFor(
        () => requests.some((h) => h.id === idB),
        "A observes the pending connect_request",
      );

      await transportA.shutdown();

      const outcome = await connectPromise;
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toBe("shutting_down");
      expect(clearIntervalSpy).toHaveBeenCalled();

      // A second shutdown-triggered decision must find nothing left pending -- shutdown() clears the whole map, not merely responds to entries in place.
      const anyHandle = requests.find((h) => h.id === idB);
      if (anyHandle === undefined)
        throw new Error("expected the request handle");
      await expect(transportA.rejectConnection(anyHandle, "x")).rejects.toThrow(
        /No pending connection/,
      );
    } finally {
      clearIntervalSpy.mockRestore();
      await transportB.shutdown();
    }
  });

  test("shutdown closes an already-accepted peer session so the far side observes a disconnect", async () => {
    const identityA = generateIdentity();
    const identityB = generateIdentity();
    const idA = await peerId(await toIdentityPort(identityA));
    const idB = await peerId(await toIdentityPort(identityB));

    const disconnectsSeenByB: ConnectionHandle[] = [];
    const transportA = new WireMeshTransport(noopEvents(), identityA);
    const transportB = new WireMeshTransport(
      noopEvents({ onPeerDisconnected: (h) => disconnectsSeenByB.push(h) }),
      identityB,
    );
    try {
      await transportA.startDataServer();
      await transportB.connectToPeer(
        {
          id: idA,
          port: transportA.dataPort,
          startedAt: new Date().toISOString(),
        },
        idB,
      );

      await transportA.shutdown();
      await waitFor(
        () => disconnectsSeenByB.some((h) => h.id === idA),
        "B observes A's session closing on shutdown",
      );
    } finally {
      await transportB.shutdown();
    }
  });
});

describe("WireMeshTransport listener policy propagation into quarantine", () => {
  test("acceptConnection propagates the accepting listener's own policy onto the resulting handle", async () => {
    const identityA = generateIdentity();
    const identityB = generateIdentity();
    const idB = await peerId(await toIdentityPort(identityB));

    const introductions: { handle: ConnectionHandle }[] = [];
    const requests: ConnectionHandle[] = [];
    const transportA = new WireMeshTransport(
      noopEvents({
        onConnectionRequest: (h) => requests.push(h),
        onIntroduction: (handle) => introductions.push({ handle }),
      }),
      identityA,
    );
    const transportB = new WireMeshTransport(noopEvents(), identityB);
    try {
      await transportA.becomeCoordinator("127.0.0.1", 0);
      const observePolicy: ListenerPolicy = "observe";
      const listenerId = await transportA.addListener(
        "127.0.0.1",
        0,
        observePolicy,
      );
      const listener = transportA
        .listListeners()
        .find((l) => l.id === listenerId);
      if (listener === undefined)
        throw new Error("expected the added listener");

      void transportB
        .connectToRemote("127.0.0.1", listener.port, idB, 0, "b", "")
        .catch(() => undefined);

      await waitFor(
        () => requests.some((h) => h.id === idB),
        "A observes the pending connect_request via the observe-policy listener",
      );
      const handle = requests.find((h) => h.id === idB);
      if (handle === undefined) throw new Error("expected the request handle");

      await transportA.acceptConnection(handle);
      await waitFor(
        () => introductions.some((i) => i.handle.id === idB),
        "A fires onIntroduction for the accepted connection",
      );
      const introduced = introductions.find((i) => i.handle.id === idB);
      expect(introduced?.handle.policy).toBe(observePolicy);
    } finally {
      await transportB.shutdown();
      await transportA.shutdown();
    }
  });
});

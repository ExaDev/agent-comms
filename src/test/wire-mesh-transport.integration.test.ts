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
import type { AgentStatus } from "../core/types.js";
import { waitFor } from "./test-transport.js";

function noopEvents(
  overrides: Readonly<Partial<TransportEvents>> = {},
): TransportEvents {
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
async function findFreePort(): Promise<number> {
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

/** Waits `ms` milliseconds -- shared boilerplate for this file's fixed settle-time waits, so each one only needs a named constant at the call site rather than its own Promise/setTimeout shape. */
async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => void setTimeout(resolve, ms));
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
      // presenceReadvertiseIntervalMs deliberately omitted: relying on the constructor's own default is the point of this test -- it proves PRESENCE_READVERTISE_INTERVAL_SECONDS * MS_PER_SECOND actually computes 20_000, not merely that *some* interval gets scheduled.
      new WireMeshTransport(noopEvents(), identity, {
        getCurrentPresence: () => "active",
      });
      // Mirrors WireMeshTransport's own default cadence (PRESENCE_READVERTISE_INTERVAL_SECONDS * MS_PER_SECOND).
      const READVERTISE_MS = 20_000;
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(setIntervalSpy.mock.calls[0]?.[1]).toBe(READVERTISE_MS);
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
      noopEvents({ onPeerDisconnected: (h) => void disconnects.push(h) }),
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
        onConnectionRequest: (handle) => void requestsSeenByA.push(handle),
        onPeerDisconnected: (handle) => void disconnectsSeenByA.push(handle),
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
      const DISCONNECT_SETTLE_MS = 300;
      await delay(DISCONNECT_SETTLE_MS);

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
      noopEvents({ onConnectionRequest: (h) => void requests.push(h) }),
      identityA,
    );
    const transportB = new WireMeshTransport(noopEvents(), identityB);
    const transportC = new WireMeshTransport(noopEvents(), identityC);
    try {
      await transportA.becomeCoordinator("127.0.0.1", 0);
      const [listener] = transportA.listListeners();
      if (listener === undefined) throw new Error("expected a bound listener");

      void transportB
        .connectToRemote({
          host: "127.0.0.1",
          port: listener.port,
          peerId: idB,
          dataPort: 0,
          name: "b",
          fingerprint: "",
        })
        .catch(() => undefined);
      void transportC
        .connectToRemote({
          host: "127.0.0.1",
          port: listener.port,
          peerId: idC,
          dataPort: 0,
          name: "c",
          fingerprint: "",
        })
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
        onConnectionRequest: (h) => void requests.push(h),
        onMessage: (_h, m) => void messagesSeenByA.push(m),
      }),
      identityA,
    );
    const transportB = new WireMeshTransport(noopEvents(), identityB);
    try {
      await transportA.becomeCoordinator("127.0.0.1", 0);
      const [listener] = transportA.listListeners();
      if (listener === undefined) throw new Error("expected a bound listener");

      const connectPromise = transportB.connectToRemote({
        host: "127.0.0.1",
        port: listener.port,
        peerId: idB,
        dataPort: 0,
        name: "b",
        fingerprint: "",
      });

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
      const SEND_SETTLE_MS = 200;
      await delay(SEND_SETTLE_MS);
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
        onConnectionRequest: (h) => void requests.push(h),
        onMessage: (_h, m) => void messagesSeenByA.push(m),
      }),
      identityA,
    );
    const transportB = new WireMeshTransport(
      noopEvents({ onMessage: (_h, m) => void messagesSeenByB.push(m) }),
      identityB,
    );
    try {
      await transportA.becomeCoordinator("127.0.0.1", 0);
      const [listener] = transportA.listListeners();
      if (listener === undefined) throw new Error("expected a bound listener");

      const connectPromise = transportB.connectToRemote({
        host: "127.0.0.1",
        port: listener.port,
        peerId: idB,
        dataPort: 0,
        name: "b",
        fingerprint: "",
      });

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
      noopEvents({ onMessage: (_h, m) => void messagesSeenByA.push(m) }),
      identityA,
    );
    const transportB = new WireMeshTransport(
      noopEvents({ onMessage: (_h, m) => void messagesSeenByB.push(m) }),
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
      noopEvents({ onError: (e) => void errors.push(e) }),
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
      noopEvents({ onError: (e) => void errors.push(e) }),
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
      noopEvents({ onConnectionRequest: (h) => void requests.push(h) }),
      identityA,
      { getCurrentPresence: () => "active" },
    );
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");
    const transportB = new WireMeshTransport(noopEvents(), identityB);
    try {
      await transportA.becomeCoordinator("127.0.0.1", 0);
      const [listener] = transportA.listListeners();
      if (listener === undefined) throw new Error("expected a bound listener");

      const connectPromise = transportB
        .connectToRemote({
          host: "127.0.0.1",
          port: listener.port,
          peerId: idB,
          dataPort: 0,
          name: "b",
          fingerprint: "",
        })
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
      noopEvents({
        onPeerDisconnected: (h) => void disconnectsSeenByB.push(h),
      }),
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
        onConnectionRequest: (h) => void requests.push(h),
        onIntroduction: (handle) => void introductions.push({ handle }),
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
        .connectToRemote({
          host: "127.0.0.1",
          port: listener.port,
          peerId: idB,
          dataPort: 0,
          name: "b",
          fingerprint: "",
        })
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

describe("WireMeshTransport readvertisePresence body", () => {
  test("a configured presence source that itself returns undefined on a given tick sends nothing that tick", async () => {
    const identityA = generateIdentity();
    const identityB = generateIdentity();
    const idA = await peerId(await toIdentityPort(identityA));

    const presenceSeenByB: AgentStatus[] = [];
    let currentStatus: AgentStatus | undefined;
    const SHORT_INTERVAL_MS = 40;
    const transportA = new WireMeshTransport(noopEvents(), identityA, {
      getCurrentPresence: () => currentStatus,
      presenceReadvertiseIntervalMs: SHORT_INTERVAL_MS,
    });
    const transportB = new WireMeshTransport(
      noopEvents({
        onPresenceAdvert: (_h, status) => void presenceSeenByB.push(status),
      }),
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
        "self",
      );

      // Several ticks with getCurrentPresence returning undefined: the early return must skip sendGossipUpdate entirely, so B must never observe a presence advert from A.
      const PRESENCE_TICKS_TO_SKIP = 4;
      await delay(SHORT_INTERVAL_MS * PRESENCE_TICKS_TO_SKIP);
      expect(presenceSeenByB.length).toBe(0);

      // Flipping to a real status proves the same interval, and the same early-return branch, genuinely does send once status is defined -- ruling out "the interval simply never fired at all" as an alternative explanation for the assertion above.
      currentStatus = "active";
      await waitFor(
        () => presenceSeenByB.includes("active"),
        "B observes A's presence once getCurrentPresence starts returning a real status",
      );
    } finally {
      await transportB.shutdown();
      await transportA.shutdown();
    }
  });

  // A test proving readvertisePresence's own catch/onError path (a gossip send failing against a session whose remote end just closed) was attempted directly against two real transports, but the disconnect is detected and cleaned up (watchForDisconnect removing the session from allSessions) faster and more reliably than a genuinely broken-but-still-tracked send could be raced into -- every attempt hit the already-cleaned-up state instead of the failing-send state, making it an inherently flaky test rather than a deterministic one. Left as a documented gap: see this PR's own report for the reasoning.
});

describe("WireMeshTransport send/sendRoomRequest to an unknown or broken peer", () => {
  test("send to a handle with no live session is a silent no-op", async () => {
    const identity = generateIdentity();
    const transport = new WireMeshTransport(noopEvents(), identity);
    try {
      await expect(
        transport.send(
          { id: "nobody-home" },
          { method: "peer_left", peerId: "x" },
        ),
      ).resolves.toBeUndefined();
    } finally {
      await transport.shutdown();
    }
  });

  // sendRoomRequest's own gateway-trust gate (agent-comms#156) has its own dedicated coverage in wire-mesh-transport-gateway-trust.test.ts, split out the same reason wire-mesh-transport-hub.test.ts/wire-mesh-transport-shutdown-unref.test.ts already were.

  // A test proving send()'s own catch/onError path (a send failing against a session whose remote end just closed) was attempted the same way and hit the identical flakiness as the gossip-failure test above -- watchForDisconnect's own cleanup consistently won the race against a still-tracked-but-broken session. Left as a documented gap for the same reason.
});

describe("WireMeshTransport pending-connection expiry", () => {
  test("a connect_request left unanswered past the configured timeout is auto-rejected with the documented timeout message", async () => {
    const identityA = generateIdentity();
    const identityB = generateIdentity();
    const idB = await peerId(await toIdentityPort(identityB));
    const SHORT_TIMEOUT_MS = 150;

    const transportA = new WireMeshTransport(noopEvents(), identityA, {
      pendingConnectionTimeoutMs: SHORT_TIMEOUT_MS,
    });
    const transportB = new WireMeshTransport(noopEvents(), identityB);
    try {
      await transportA.becomeCoordinator("127.0.0.1", 0);
      const [listener] = transportA.listListeners();
      if (listener === undefined) throw new Error("expected a bound listener");

      const connectPromise = transportB.connectToRemote({
        host: "127.0.0.1",
        port: listener.port,
        peerId: idB,
        dataPort: 0,
        name: "b",
        fingerprint: "",
      });

      await expect(connectPromise).rejects.toThrow(
        "no human decision within the pending-connection timeout",
      );
    } finally {
      await transportB.shutdown();
      await transportA.shutdown();
    }
  });
});

describe("WireMeshTransport accepting side's own disconnect wiring and dial dedup", () => {
  test("the accepting side observes onPeerDisconnected when the peer it accepted a connection from disconnects", async () => {
    const identityA = generateIdentity();
    const identityB = generateIdentity();
    const idB = await peerId(await toIdentityPort(identityB));

    const disconnectsSeenByA: ConnectionHandle[] = [];
    const transportA = new WireMeshTransport(
      noopEvents({
        onPeerDisconnected: (h) => void disconnectsSeenByA.push(h),
      }),
      identityA,
    );
    const transportB = new WireMeshTransport(noopEvents(), identityB);
    try {
      await transportA.startDataServer();
      await transportB.connectToPeer(
        {
          id: await peerId(await toIdentityPort(identityA)),
          port: transportA.dataPort,
          startedAt: new Date().toISOString(),
        },
        idB,
      );

      // B, the dialled-to side's peer, disconnects -- this must surface through A's OWN watchForDisconnect wiring (registered when A itself accepted the incoming connection in handleAcceptedConnection), not merely through B's own symmetric wiring on the dialling side.
      await transportB.shutdown();
      await waitFor(
        () => disconnectsSeenByA.some((h) => h.id === idB),
        "A observes B's disconnection via its own accepting-side wiring",
      );
    } finally {
      await transportA.shutdown();
    }
  });

  test("a peer that disconnects is removed from the dial-dedup set, so it can be dialled again afterwards", async () => {
    const identityA = generateIdentity();
    const identityB = generateIdentity();
    const idA = await peerId(await toIdentityPort(identityA));

    // transportA1 and transportA2 both hold identityA -- the same peer id -- but are two separate transport instances so the first can go through shutdown() (a terminal, one-way state for whichever transport calls it) while a genuinely fresh listener stands in for "the same peer, reachable again" for the second dial. transportB itself is never shut down: it's the one whose own dataDials bookkeeping this test is about.
    const connectsSeenByA: ConnectionHandle[] = [];
    const transportA1 = new WireMeshTransport(
      noopEvents({ onPeerConnected: (h) => void connectsSeenByA.push(h) }),
      identityA,
    );
    const transportB = new WireMeshTransport(noopEvents(), identityB);
    let transportA2: WireMeshTransport | undefined;
    try {
      await transportA1.startDataServer();
      await transportB.connectToPeer(
        {
          id: idA,
          port: transportA1.dataPort,
          startedAt: new Date().toISOString(),
        },
        "self",
      );
      await waitFor(
        () => connectsSeenByA.length === 1,
        "A observes the first connection",
      );

      // The first A instance goes away; B's own watchForDisconnect must clear idA out of its dataDials so a second connectToPeer for the same peer id is not silently treated as "already dialled" and skipped.
      await transportA1.shutdown();
      const DEDUP_SETTLE_MS = 200;
      await delay(DEDUP_SETTLE_MS);

      transportA2 = new WireMeshTransport(
        noopEvents({ onPeerConnected: (h) => void connectsSeenByA.push(h) }),
        identityA,
      );
      await transportA2.startDataServer();
      await transportB.connectToPeer(
        {
          id: idA,
          port: transportA2.dataPort,
          startedAt: new Date().toISOString(),
        },
        "self",
      );
      await waitFor(
        () => connectsSeenByA.length === 2,
        "A observes a genuinely new second connection, proving the earlier dial was not silently deduplicated away",
      );
    } finally {
      await transportB.shutdown();
      await transportA1.shutdown();
      await transportA2?.shutdown();
    }
  });
});

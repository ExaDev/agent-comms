/**
 * WireMeshTransport shutdown()/unref() -- direct mechanism assertions, split out of wire-mesh-transport.test.ts to stay under this repo's max-lines cap. Existing shutdown coverage in the sibling file proves observable, cross-peer behaviour (B sees A's session close, a second decision finds nothing pending). These tests instead assert directly on the specific cleanup mechanisms shutdown() itself performs -- the underlying Map/Set.clear() calls, timer cancellations, and listener unref() calls -- so a mutation removing one of those calls fails here even when nothing was ever added to the collection it clears, which no behavioural assertion downstream of an empty collection could otherwise observe.
 */

import * as net from "node:net";
import { test, describe, expect, vi } from "vitest";
import { createTlsTransport } from "wire-mesh-core/adapters/tls-transport";
import {
  acceptMeshSession,
  type AcceptedMeshSession,
} from "wire-mesh-core/domain/mesh-session";
import { generateIdentity } from "../core/identity.js";
import { toIdentityPort } from "../core/wire-mesh-identity.js";
import {
  WireMeshTransport,
  DOMAIN,
  FRAME_SCOPE,
  buildCommand,
} from "../core/wire-mesh-transport.js";
import type { ConnectionHandle, TransportEvents } from "../core/transport.js";
import type { AgentStatus } from "../core/types.js";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
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
    onDeviceReachable: () => undefined,
    ...overrides,
  };
}

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
  return deviceIdToHex(Uint8Array.from(identity.deviceId));
}

// pendingConnections, peerSessions, coordinatorListeners -- the three Maps shutdown() clears.
const SHUTDOWN_MAP_CLEAR_COUNT = 3;

describe("WireMeshTransport shutdown -- direct mechanism assertions", () => {
  test("shutdown clears every internal bookkeeping collection, even when all of them are already empty", async () => {
    const identity = generateIdentity();
    const transport = new WireMeshTransport(noopEvents(), identity);
    const mapClearSpy = vi.spyOn(Map.prototype, "clear");
    const setClearSpy = vi.spyOn(Set.prototype, "clear");
    try {
      await transport.shutdown();
      // dataDials, allSessions (Sets) + pendingConnections, peerSessions, coordinatorListeners (Maps) -- five distinct collections shutdown() is documented to clear, regardless of whether any of them held anything.
      expect(setClearSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(mapClearSpy.mock.calls.length).toBeGreaterThanOrEqual(
        SHUTDOWN_MAP_CLEAR_COUNT,
      );
    } finally {
      mapClearSpy.mockRestore();
      setClearSpy.mockRestore();
    }
  });

  test("shutdown cancels the pending-connection timeout for every still-pending connect_request, not just its own reject response", async () => {
    const identityA = generateIdentity();
    const identityB = generateIdentity();
    const idB = await peerId(await toIdentityPort(identityB));
    const requestsSeenByA: ConnectionHandle[] = [];
    const transportA = new WireMeshTransport(
      noopEvents({
        onConnectionRequest: (h) => void requestsSeenByA.push(h),
      }),
      identityA,
    );
    const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");
    try {
      await transportA.becomeCoordinator("127.0.0.1", 0);
      const [listener] = transportA.listListeners();
      if (listener === undefined) throw new Error("expected a bound listener");

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
      clearTimeoutSpy.mockClear();

      await transportA.shutdown();

      expect(clearTimeoutSpy).toHaveBeenCalled();
      await session.close();
    } finally {
      clearTimeoutSpy.mockRestore();
      await transportA.shutdown();
    }
  });

  test("shutdown clears the presence-readvertise interval when one was started", async () => {
    const identity = generateIdentity();
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");
    try {
      const transport = new WireMeshTransport(noopEvents(), identity, {
        getCurrentPresence: () => "active",
      });
      clearIntervalSpy.mockClear();
      await transport.shutdown();
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    } finally {
      clearIntervalSpy.mockRestore();
    }
  });

  test("shutdown does not call clearInterval at all when no presence source was ever configured", async () => {
    const identity = generateIdentity();
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");
    try {
      const transport = new WireMeshTransport(noopEvents(), identity);
      clearIntervalSpy.mockClear();
      await transport.shutdown();
      expect(clearIntervalSpy).not.toHaveBeenCalled();
    } finally {
      clearIntervalSpy.mockRestore();
    }
  });

  test("a connect_request left unanswered past the configured timeout is auto-rejected with the documented error code", async () => {
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
      const outcome = await session.sendManageRequest(
        buildCommand({
          method: "connect_request",
          peerId: idB,
          dataPort: 0,
          name: "connector",
          fingerprint: "",
        }),
        FRAME_SCOPE,
      );

      expect(outcome).toMatchObject({ result: "error", code: "timeout" });
      await session.close();
    } finally {
      await transportB.shutdown();
      await transportA.shutdown();
    }
  });
});

describe("WireMeshTransport unref", () => {
  test("unrefs the data listener and every coordinator listener, not just one of them", async () => {
    const identity = generateIdentity();
    const transport = new WireMeshTransport(noopEvents(), identity);
    const unrefSpy = vi.spyOn(net.Server.prototype, "unref");
    try {
      await transport.startDataServer();
      const port = await findFreePort();
      await transport.addListener("127.0.0.1", port, "full");
      unrefSpy.mockClear();

      transport.unref();

      // The data listener plus exactly one added coordinator listener -- two distinct real net.Server instances, each individually unref'd.
      expect(unrefSpy).toHaveBeenCalledTimes(2);
    } finally {
      unrefSpy.mockRestore();
      await transport.shutdown();
    }
  });

  test("unref with no listeners started at all is a safe no-op, not a throw", async () => {
    const identity = generateIdentity();
    const transport = new WireMeshTransport(noopEvents(), identity);
    expect(() => {
      transport.unref();
    }).not.toThrow();
  });
});

/** Reaches WireMeshTransport's own private allSessions Set for a whitebox check -- TypeScript's `private` is compile-time only, and proving the coordinator port is released independently of a slow-closing session's own close() needs a real session this test can make artificially slow, which the public API has no way to hand back (see the file header for why this style of cast is the established one here). */
function ownSessions(transport: WireMeshTransport): Set<AcceptedMeshSession> {
  return (transport as unknown as { allSessions: Set<AcceptedMeshSession> })
    .allSessions;
}

describe("WireMeshTransport shutdown -- coordinator listener release ordering (agent-comms#302)", () => {
  /** A graceful coordinator handover already sends the become_coordinator message before the outgoing coordinator's own shutdown() runs (PeerLifecycle.sendCoordinatorHandover, called ahead of transport.shutdown() in MeshStore.shutdown()), so the successor can start racing to rebind the port as soon as that message arrives -- independent of, and often well before, this side finishes closing its own other sessions. The successor's own bind retries (BECOME_COORDINATOR_BIND_RETRIES/_DELAY_MS in bind-retry.ts) only tolerate a bounded amount of that gap, so shutdown() must release the coordinator's own listening port promptly rather than only after every other session has also finished closing. */
  test("releases the coordinator listening port well before a slow-closing session's own close() resolves", async () => {
    const identityA = generateIdentity();
    const identityB = generateIdentity();
    const transportA = new WireMeshTransport(noopEvents(), identityA);
    const clientTransport = createTlsTransport({
      certificatePem: identityB.certificate,
      privateKeyPem: identityB.privateKey,
    });
    let connection:
      Awaited<ReturnType<typeof clientTransport.connect>> | undefined;
    try {
      await transportA.becomeCoordinator("127.0.0.1", 0);
      const [listener] = transportA.listListeners();
      if (listener === undefined) throw new Error("expected a bound listener");
      const { port } = listener;

      // Any TLS-authenticated connection to the coordinator listener is tracked in allSessions immediately, before connect_request approval (handleAcceptedConnection's own quarantine-but-track behaviour) -- this test only needs A's own local session object to exist and be closeable slowly, not a fully approved peer.
      connection = await clientTransport.connect(`127.0.0.1:${String(port)}`);
      await waitFor(
        () => ownSessions(transportA).size > 0,
        "A tracks the new session",
      );
      const [session] = ownSessions(transportA);
      if (session === undefined) throw new Error("expected a tracked session");
      const SLOW_CLOSE_DELAY_MS = 200;
      const realClose = session.close.bind(session);
      session.close = async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, SLOW_CLOSE_DELAY_MS);
        });
        await realClose();
      };

      const shutdownPromise = transportA.shutdown();

      // Comfortably under SLOW_CLOSE_DELAY_MS -- succeeding within this bound proves the listener released independently of, not after, the slow session's own close().
      const REBIND_TIMEOUT_MS = 100;
      const REBIND_POLL_INTERVAL_MS = 5;
      const deadline = Date.now() + REBIND_TIMEOUT_MS;
      let rebound = false;
      while (Date.now() < deadline) {
        const probe = net.createServer();
        const bound = await new Promise<boolean>((resolve) => {
          probe.once("error", () => resolve(false));
          probe.listen(port, "127.0.0.1", () => resolve(true));
        });
        if (bound) {
          await new Promise<void>((resolve) => {
            probe.close(() => {
              resolve();
            });
          });
          rebound = true;
          break;
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, REBIND_POLL_INTERVAL_MS);
        });
      }

      expect(rebound).toBe(true);

      await shutdownPromise;
    } finally {
      await connection?.close().catch(() => undefined);
      await transportA.shutdown();
    }
  });
});

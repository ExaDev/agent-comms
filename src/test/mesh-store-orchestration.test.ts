/**
 * Direct unit tests for MeshStore's own orchestration logic -- requireTransport/requireIdentity's guard errors, the connected getter, init()'s connect-vs-becomeCoordinator-vs-EADDRINUSE branching, the events getter's dispatch table, federation/listener/room-join-approval passthroughs, and shutdown() -- as opposed to the collaborator-owned behaviour wireTestTransport-based integration tests already cover end-to-end. MeshStore's constructor takes no injectable deps (unlike its collaborators), so these tests use a hand-built fake MeshTransport passed to the real setTransport(), and reach the private roomProtocol/connectionApproval/peerLifecycle/deliveryEngine/agentRegistry collaborators via a narrow, explicitly-justified cast -- TypeScript's `private` is compile-time only, and asserting a delegating wrapper actually calls through to the collaborator that owns the real implementation is exactly the kind of whitebox check no public-API-only test can express for a one-line pass-through.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MeshStore } from "../core/mesh-store.js";
import type { ConnectionHandle, MeshTransport } from "../core/transport.js";
import type { ManageOutcome } from "wire-mesh-core/domain/mesh-session";
import type { PeerInfo } from "../core/wire-protocol.js";

/** A device-id is a 64-character lowercase hex SHA-256 digest; room-path.ts's assertDeviceIdHex rejects anything shorter. */
const DEVICE_ID_HEX_LENGTH = 64;
const VALID_DEVICE_ID = "a".repeat(DEVICE_ID_HEX_LENGTH);
/** Arbitrary, distinctive remote port for a connectToRemote test fixture -- no significance beyond "a real-looking port number". */
const REMOTE_PORT = 4242;

function fakeTransport(): MeshTransport {
  return {
    dataPort: 4000,
    isCoordinator: false,
    hasCoordinatorConnection: false,
    startDataServer: vi.fn().mockResolvedValue(undefined),
    connectToCoordinator: vi.fn().mockResolvedValue(undefined),
    becomeCoordinator: vi.fn().mockResolvedValue(undefined),
    connectToPeer: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    acceptConnection: vi.fn().mockResolvedValue(undefined),
    rejectConnection: vi.fn().mockResolvedValue(undefined),
    connectToRemote: vi.fn().mockResolvedValue(undefined),
    broadcast: vi.fn().mockResolvedValue(undefined),
    broadcastRevocation: vi.fn().mockResolvedValue(undefined),
    sendRoomRequest: vi.fn().mockResolvedValue({
      result: "error",
      code: "not_connected",
    } satisfies ManageOutcome),
    addListener: vi.fn().mockResolvedValue("listener-1"),
    removeListener: vi.fn().mockResolvedValue(undefined),
    listListeners: vi.fn().mockReturnValue([]),
    shutdown: vi.fn().mockResolvedValue(undefined),
    unref: vi.fn<() => void>(),
  };
}

/** Reaches a private collaborator for a whitebox delegation check -- see the file header for why this cast is justified rather than avoided. Returns `unknown`; each call site casts to the narrow method slice it actually needs. */
function collaborator(store: MeshStore, name: string): unknown {
  return (store as unknown as Record<string, unknown>)[name];
}

describe("MeshStore — requireTransport/requireIdentity guards", () => {
  it("throws a specific error when a transport-using method is called before setTransport()", () => {
    const store = new MeshStore();
    expect(() => store.listListeners()).toThrow(
      "MeshStore: no transport set; call setTransport() before using the store",
    );
  });

  it("throws a specific error when an identity-using method is called before setIdentity()", async () => {
    const store = new MeshStore();
    store.setTransport(fakeTransport());
    await expect(
      store.createRoom({
        name: "r",
        type: "public",
        owner: VALID_DEVICE_ID,
        description: "",
      }),
    ).rejects.toThrow(
      "MeshStore: no identity set; call setIdentity() before using the store",
    );
  });
});

describe("MeshStore — connected getter", () => {
  it("is true when the transport is the coordinator", () => {
    const store = new MeshStore();
    const transport = fakeTransport();
    (transport as { isCoordinator: boolean }).isCoordinator = true;
    store.setTransport(transport);
    expect(store.connected).toBe(true);
  });

  it("is true when the transport has a live coordinator connection", () => {
    const store = new MeshStore();
    const transport = fakeTransport();
    (
      transport as { hasCoordinatorConnection: boolean }
    ).hasCoordinatorConnection = true;
    store.setTransport(transport);
    expect(store.connected).toBe(true);
  });

  it("is false when neither is true", () => {
    const store = new MeshStore();
    store.setTransport(fakeTransport());
    expect(store.connected).toBe(false);
  });
});

describe("MeshStore — init()", () => {
  it("starts the data server, records its own peer info, connects to an existing coordinator, and unrefs -- without becoming coordinator", async () => {
    const store = new MeshStore();
    const transport = fakeTransport();
    store.setTransport(transport);

    await store.init();

    expect(transport.startDataServer).toHaveBeenCalledTimes(1);
    expect(transport.connectToCoordinator).toHaveBeenCalledTimes(1);
    expect(transport.becomeCoordinator).not.toHaveBeenCalled();
    expect(transport.unref).toHaveBeenCalledTimes(1);
  });

  it("falls back to becoming coordinator when no existing coordinator is reachable", async () => {
    const store = new MeshStore();
    const transport = fakeTransport();
    vi.mocked(transport.connectToCoordinator).mockRejectedValue(
      new Error("ECONNREFUSED"),
    );
    store.setTransport(transport);
    const staleAgentChecker = collaborator(store, "staleAgentChecker") as {
      start: ReturnType<typeof vi.fn>;
    };
    const startSpy = vi.spyOn(staleAgentChecker, "start");

    await store.init();

    expect(transport.becomeCoordinator).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(transport.unref).toHaveBeenCalledTimes(1);
  });

  it("degrades gracefully (no throw, onError fires) when becomeCoordinator fails with EADDRINUSE", async () => {
    const store = new MeshStore();
    const transport = fakeTransport();
    vi.mocked(transport.connectToCoordinator).mockRejectedValue(
      new Error("ECONNREFUSED"),
    );
    vi.mocked(transport.becomeCoordinator).mockRejectedValue(
      new Error("listen EADDRINUSE: address already in use"),
    );
    store.setTransport(transport);
    const onError = vi.fn<(error: Error) => void>();
    store.onError = onError;

    await expect(store.init()).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]?.message).toContain(
      "could not join or create mesh",
    );
    expect(onError.mock.calls[0]?.[0]?.message).toContain(
      "Running without mesh — agent-comms will be unavailable.",
    );
    expect(transport.unref).not.toHaveBeenCalled();
  });

  it("rethrows a becomeCoordinator failure that isn't EADDRINUSE", async () => {
    const store = new MeshStore();
    const transport = fakeTransport();
    vi.mocked(transport.connectToCoordinator).mockRejectedValue(
      new Error("ECONNREFUSED"),
    );
    vi.mocked(transport.becomeCoordinator).mockRejectedValue(
      new Error("EPERM: permission denied"),
    );
    store.setTransport(transport);

    await expect(store.init()).rejects.toThrow("EPERM");
  });

  it("is idempotent -- a second call does nothing", async () => {
    const store = new MeshStore();
    const transport = fakeTransport();
    store.setTransport(transport);

    await store.init();
    await store.init();

    expect(transport.startDataServer).toHaveBeenCalledTimes(1);
  });
});

describe("MeshStore — events getter dispatch table", () => {
  it("dispatches every transport event to the collaborator method that owns it", () => {
    const store = new MeshStore();
    store.setTransport(fakeTransport());

    const peerLifecycle = collaborator(store, "peerLifecycle") as {
      handleDataMessage: ReturnType<typeof vi.fn>;
      handlePeerConnected: ReturnType<typeof vi.fn>;
      handlePeerDisconnected: ReturnType<typeof vi.fn>;
      handleIntroduction: ReturnType<typeof vi.fn>;
      handlePeerList: ReturnType<typeof vi.fn>;
      handlePeerJoined: ReturnType<typeof vi.fn>;
      handleBecomeCoordinator: ReturnType<typeof vi.fn>;
    };
    const connectionApproval = collaborator(store, "connectionApproval") as {
      handleConnectionRequest: ReturnType<typeof vi.fn>;
    };
    const deliveryEngine = collaborator(store, "deliveryEngine") as {
      handleRevocationAnnounce: ReturnType<typeof vi.fn>;
      handlePresenceAdvert: ReturnType<typeof vi.fn>;
    };

    const spies = {
      handleDataMessage: vi
        .spyOn(peerLifecycle, "handleDataMessage")
        .mockResolvedValue(undefined),
      handlePeerConnected: vi
        .spyOn(peerLifecycle, "handlePeerConnected")
        .mockResolvedValue(undefined),
      handlePeerDisconnected: vi
        .spyOn(peerLifecycle, "handlePeerDisconnected")
        .mockReturnValue(undefined),
      handleIntroduction: vi
        .spyOn(peerLifecycle, "handleIntroduction")
        .mockResolvedValue(undefined),
      handlePeerList: vi
        .spyOn(peerLifecycle, "handlePeerList")
        .mockReturnValue(undefined),
      handlePeerJoined: vi
        .spyOn(peerLifecycle, "handlePeerJoined")
        .mockReturnValue(undefined),
      handleBecomeCoordinator: vi
        .spyOn(peerLifecycle, "handleBecomeCoordinator")
        .mockResolvedValue(undefined),
      handleConnectionRequest: vi
        .spyOn(connectionApproval, "handleConnectionRequest")
        .mockReturnValue(undefined),
      handleRevocationAnnounce: vi
        .spyOn(deliveryEngine, "handleRevocationAnnounce")
        .mockResolvedValue(undefined),
      handlePresenceAdvert: vi
        .spyOn(deliveryEngine, "handlePresenceAdvert")
        .mockReturnValue(undefined),
    };

    const handle: Readonly<ConnectionHandle> = { id: "conn-1" };
    const peer: Readonly<PeerInfo> = {
      id: "peer-1",
      port: 1,
      startedAt: "2026-01-01T00:00:00.000Z",
    };

    store.events.onMessage(handle, {
      method: "state_update",
      patch: { type: "room_delete", roomId: "r" },
    });
    expect(spies.handleDataMessage).toHaveBeenCalledWith(handle, {
      method: "state_update",
      patch: { type: "room_delete", roomId: "r" },
    });

    store.events.onPeerConnected(handle, peer);
    expect(spies.handlePeerConnected).toHaveBeenCalledWith(handle, peer);

    store.events.onPeerDisconnected(handle);
    expect(spies.handlePeerDisconnected).toHaveBeenCalledWith(handle);

    store.events.onIntroduction(handle, { peerId: "p", dataPort: 1 });
    expect(spies.handleIntroduction).toHaveBeenCalledWith(handle, {
      peerId: "p",
      dataPort: 1,
    });

    store.events.onPeerList([peer]);
    expect(spies.handlePeerList).toHaveBeenCalledWith([peer]);

    store.events.onPeerJoined(peer);
    expect(spies.handlePeerJoined).toHaveBeenCalledWith(peer);

    store.events.onBecomeCoordinator([peer]);
    expect(spies.handleBecomeCoordinator).toHaveBeenCalledWith([peer]);

    store.events.onConnectionRequest(handle, {
      peerId: "p",
      dataPort: 1,
      name: "n",
      fingerprint: "fp",
    });
    expect(spies.handleConnectionRequest).toHaveBeenCalledWith(handle, {
      peerId: "p",
      dataPort: 1,
      name: "n",
      fingerprint: "fp",
    });

    const revocationEntry = {
      tokenId: new Uint8Array(),
      issuer: new Uint8Array(),
      revokedAt: 0,
    };
    store.events.onRevocationAnnounce(revocationEntry as never);
    expect(spies.handleRevocationAnnounce).toHaveBeenCalledWith(
      revocationEntry,
    );

    store.events.onPresenceAdvert(handle, "active");
    expect(spies.handlePresenceAdvert).toHaveBeenCalledWith("conn-1", "active");
  });

  it("forwards a transport-level error to this store's own onError, when one is set", () => {
    const store = new MeshStore();
    store.setTransport(fakeTransport());
    const onError = vi.fn<(error: Error) => void>();
    store.onError = onError;

    const error = new Error("transport failure");
    store.events.onError?.(error);

    expect(onError).toHaveBeenCalledWith(error);
  });
});

describe("MeshStore — constructor wiring", () => {
  it("registers both the mdns and tailscale discovery backends", async () => {
    const store = new MeshStore();
    await expect(
      store.discovery.advertise("not-a-real-backend", { name: "x", port: 1 }),
    ).rejects.toThrow("Available: mdns, tailscale");
  });

  it("fires onPatch when a broadcasted patch reaches it, via the getOnPatch closure passed to DeliveryEngine", async () => {
    const store = new MeshStore();
    store.setTransport(fakeTransport());
    const onPatch = vi.fn<(patch: unknown) => void>();
    store.onPatch = onPatch;

    await store.registerAgent({
      name: "a",
      harness: "pi",
      cwd: "/tmp",
      pid: 1,
      visibility: "visible",
      tags: [],
    });

    expect(onPatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "agent_upsert" }),
    );
  });

  it("wires ConnectionApproval's queueDelivery closure to the real DeliveryEngine, observable via drainDelivery", async () => {
    const store = new MeshStore();
    store.setTransport(fakeTransport());

    store.events.onConnectionRequest(
      { id: "conn-1" },
      { peerId: "remote", dataPort: 1, name: "n", fingerprint: "fp" },
    );

    const drained = await store.drainDelivery(store.peerId);
    expect(drained).toContainEqual(
      expect.objectContaining({
        type: "connection_request",
        connectionId: "conn-1",
      }),
    );
  });

  it("deliver() actually reaches the real DeliveryEngine, observable via drainDelivery", async () => {
    const store = new MeshStore();
    store.setTransport(fakeTransport());
    const event = {
      type: "connection_request" as const,
      connectionId: "c",
      peerId: "p",
      dataPort: 1,
      name: "n",
      fingerprint: "fp",
    };

    await store.deliver(store.peerId, event);

    const drained = await store.drainDelivery(store.peerId);
    expect(drained).toContainEqual(event);
  });
});

describe("MeshStore — identity delegation", () => {
  it("writeIdentity actually persists to the identity cache, readable back by readIdentity", async () => {
    const store = new MeshStore();
    await store.writeIdentity("pi", "/tmp", "written-id");
    await expect(store.readIdentity("pi", "/tmp")).resolves.toEqual({
      id: "written-id",
    });
  });
});

describe("MeshStore — agent lifecycle delegation", () => {
  it("setAgentOffline actually marks the agent offline in listAgents' own view", async () => {
    const store = new MeshStore();
    store.setTransport(fakeTransport());
    const agent = await store.registerAgent({
      name: "a",
      harness: "pi",
      cwd: "/tmp",
      pid: 1,
      visibility: "visible",
      tags: [],
    });

    await store.setAgentOffline(agent.id);

    const listed = await store.listAgents(agent.id);
    expect(listed.find((a) => a.id === agent.id)?.status).toBe("offline");
  });
});

describe("MeshStore — addListener policy validation", () => {
  it("rejects an invalid policy naming the exact bad value, without ever touching the transport", async () => {
    const store = new MeshStore();
    const transport = fakeTransport();
    store.setTransport(transport);

    await expect(
      store.addListener("127.0.0.1", 0, "not-a-real-policy"),
    ).rejects.toMatchObject({
      message: 'Invalid policy "not-a-real-policy"',
      code: "INVALID_POLICY",
    });
    expect(transport.addListener).not.toHaveBeenCalled();
  });

  it.each(["full", "observe", "rooms-only", "gateway"] as const)(
    "accepts the valid policy %s and forwards it to the transport",
    async (policy) => {
      const store = new MeshStore();
      const transport = fakeTransport();
      store.setTransport(transport);

      await store.addListener("127.0.0.1", 0, policy);

      expect(transport.addListener).toHaveBeenCalledWith(
        "127.0.0.1",
        0,
        policy,
      );
    },
  );
});

describe("MeshStore — room-join approval passthroughs", () => {
  it("acceptRoomJoin/rejectRoomJoin/listPendingRoomJoins all reach the real RoomProtocol collaborator", () => {
    const store = new MeshStore();
    store.setTransport(fakeTransport());
    const roomProtocol = collaborator(store, "roomProtocol") as {
      acceptRoomJoin: ReturnType<typeof vi.fn>;
      rejectRoomJoin: ReturnType<typeof vi.fn>;
      listPendingRoomJoins: ReturnType<typeof vi.fn>;
    };
    const acceptSpy = vi
      .spyOn(roomProtocol, "acceptRoomJoin")
      .mockReturnValue(undefined);
    const rejectSpy = vi
      .spyOn(roomProtocol, "rejectRoomJoin")
      .mockReturnValue(undefined);
    const listSpy = vi
      .spyOn(roomProtocol, "listPendingRoomJoins")
      .mockReturnValue([]);

    store.acceptRoomJoin("room-path", "requester");
    expect(acceptSpy).toHaveBeenCalledWith("room-path", "requester");

    store.rejectRoomJoin("room-path", "requester", "no thanks");
    expect(rejectSpy).toHaveBeenCalledWith(
      "room-path",
      "requester",
      "no thanks",
    );

    store.listPendingRoomJoins();
    expect(listSpy).toHaveBeenCalledTimes(1);
  });

  it("connectToRemote reaches the real ConnectionApproval collaborator", async () => {
    const store = new MeshStore();
    store.setTransport(fakeTransport());
    const connectionApproval = collaborator(store, "connectionApproval") as {
      connectToRemote: ReturnType<typeof vi.fn>;
    };
    const spy = vi
      .spyOn(connectionApproval, "connectToRemote")
      .mockResolvedValue(undefined);

    await store.connectToRemote("example.test", REMOTE_PORT);

    expect(spy).toHaveBeenCalledWith("example.test", REMOTE_PORT);
  });
});

describe("MeshStore — federation passthroughs", () => {
  it("forwards fedConnect/fedDisconnect/fedLinks/fedTrust/fedUntrust/fedTrustedFingerprints/fedListen/fedStopListening to the real, public federation manager", async () => {
    const store = new MeshStore();
    store.setTransport(fakeTransport());

    const connectSpy = vi
      .spyOn(store.federation, "connect")
      .mockResolvedValue("link-1");
    await expect(store.fedConnect("host", 1, "name")).resolves.toBe("link-1");
    expect(connectSpy).toHaveBeenCalledWith("host", 1, "name");

    const disconnectSpy = vi
      .spyOn(store.federation, "disconnect")
      .mockResolvedValue(undefined);
    await store.fedDisconnect("link-1");
    expect(disconnectSpy).toHaveBeenCalledWith("link-1");

    const linksSpy = vi
      .spyOn(store.federation, "listLinks")
      .mockReturnValue([]);
    store.fedLinks();
    expect(linksSpy).toHaveBeenCalledTimes(1);

    const trustSpy = vi
      .spyOn(store.federation, "addTrustedFingerprint")
      .mockReturnValue(undefined);
    await store.fedTrust("fingerprint-a");
    expect(trustSpy).toHaveBeenCalledWith("fingerprint-a");

    const untrustSpy = vi
      .spyOn(store.federation, "removeTrustedFingerprint")
      .mockReturnValue(undefined);
    await store.fedUntrust("fingerprint-a");
    expect(untrustSpy).toHaveBeenCalledWith("fingerprint-a");

    const listTrustedSpy = vi
      .spyOn(store.federation, "listTrustedFingerprints")
      .mockReturnValue([]);
    store.fedTrustedFingerprints();
    expect(listTrustedSpy).toHaveBeenCalledTimes(1);

    const listenSpy = vi
      .spyOn(store.federation, "listen")
      .mockResolvedValue(undefined);
    await store.fedListen("host", 2);
    expect(listenSpy).toHaveBeenCalledWith("host", 2);

    const stopListeningSpy = vi
      .spyOn(store.federation, "stopListening")
      .mockResolvedValue(undefined);
    await store.fedStopListening();
    expect(stopListeningSpy).toHaveBeenCalledTimes(1);
  });
});

describe("MeshStore — shutdown()", () => {
  let store: MeshStore;
  let transport: ReturnType<typeof fakeTransport>;

  beforeEach(() => {
    store = new MeshStore();
    transport = fakeTransport();
    store.setTransport(transport);
  });

  it("stops the stale-agent checker, shuts down federation, and shuts down the transport", async () => {
    const staleAgentChecker = collaborator(store, "staleAgentChecker") as {
      stop: ReturnType<typeof vi.fn>;
    };
    const stopSpy = vi.spyOn(staleAgentChecker, "stop");
    const federationShutdownSpy = vi
      .spyOn(store.federation, "shutdown")
      .mockResolvedValue(undefined);

    await store.shutdown();

    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(federationShutdownSpy).toHaveBeenCalledTimes(1);
    expect(transport.shutdown).toHaveBeenCalledTimes(1);
  });

  it("broadcasts agent_offline for its own self agent when one is registered", async () => {
    vi.spyOn(store.federation, "shutdown").mockResolvedValue(undefined);
    const agent = await store.registerAgent({
      name: "self",
      harness: "pi",
      cwd: "/tmp",
      pid: 1,
      visibility: "visible",
      tags: [],
    });
    store.peerId = agent.id;
    const deliveryEngine = collaborator(store, "deliveryEngine") as {
      broadcastPatch: ReturnType<typeof vi.fn>;
    };
    const broadcastSpy = vi
      .spyOn(deliveryEngine, "broadcastPatch")
      .mockResolvedValue(undefined);

    await store.shutdown();

    expect(broadcastSpy).toHaveBeenCalledWith({
      type: "agent_offline",
      agentId: agent.id,
    });
  });

  it("clears every pending markRead timer", async () => {
    vi.spyOn(store.federation, "shutdown").mockResolvedValue(undefined);
    const pending = collaborator(store, "pendingMarkReadTimers") as ReturnType<
      typeof setTimeout
    >[];
    // Long enough to guarantee it's still pending (never fires) for the duration of this test.
    const FAR_FUTURE_DELAY_MS = 1_000_000;
    const timer = setTimeout(() => undefined, FAR_FUTURE_DELAY_MS);
    pending.push(timer);
    const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");

    try {
      await store.shutdown();
      expect(clearTimeoutSpy).toHaveBeenCalledWith(timer);
      expect(pending).toHaveLength(0);
    } finally {
      clearTimeoutSpy.mockRestore();
    }
  });

  it("actually sets isShutDown, observable via DeliveryEngine no longer scheduling markRead timers afterward", async () => {
    vi.spyOn(store.federation, "shutdown").mockResolvedValue(undefined);
    await store.shutdown();

    const pending = collaborator(store, "pendingMarkReadTimers") as unknown[];
    await store.deliver(store.peerId, {
      type: "room_message",
      message: {
        id: "m",
        from: "a",
        room: "r",
        content: "hi",
        timestamp: "2026-01-01T00:00:00.000Z",
        readBy: [],
      },
    });

    expect(pending).toHaveLength(0);
  });

  it("does not broadcast agent_offline when no self agent was ever registered", async () => {
    vi.spyOn(store.federation, "shutdown").mockResolvedValue(undefined);
    const deliveryEngine = collaborator(store, "deliveryEngine") as {
      broadcastPatch: ReturnType<typeof vi.fn>;
    };
    const broadcastSpy = vi
      .spyOn(deliveryEngine, "broadcastPatch")
      .mockResolvedValue(undefined);

    await store.shutdown();

    expect(broadcastSpy).not.toHaveBeenCalled();
  });
});

/**
 * Direct, DI-based unit tests for PeerLifecycle -- it was previously exercised only indirectly through end-to-end mesh integration tests, leaving several individual branches, self-connect guards, and handleDataMessage's method-dispatch branches unobserved. A few of the survivors Stryker reports against handleDataMessage's whole-suite timeout classification: emptying its body doesn't fail fast, it hangs some unrelated integration test waiting on state that never arrives, so a direct unit test that fails immediately on the same mutation converts a slow timeout into a fast, precise kill. PeerLifecycleDeps is a narrow, injectable surface built exactly for this direct testing.
 */
import { describe, expect, it, vi } from "vitest";
import {
  PeerLifecycle,
  type PeerLifecycleDeps,
} from "../core/peer-lifecycle.js";
import type { AgentIdentity, DeliveryEvent } from "../core/types.js";
import type { PeerInfo, SerialisedState } from "../core/wire-protocol.js";

const OWNER_ID = "owner-device";
const COORDINATOR_PORT = 19876;

function peerInfo(
  id: string,
  options?: { port?: number; startedAt?: string },
): PeerInfo {
  const { port = 1, startedAt = "2026-01-01T00:00:00.000Z" } = options ?? {};
  return { id, port, startedAt };
}

function emptyState(): SerialisedState {
  return { agents: {}, rooms: {}, messages: {}, dms: {}, deliveryQueues: {} };
}

interface Harness {
  deps: PeerLifecycleDeps;
  lifecycle: PeerLifecycle;
  transport: {
    isCoordinator: boolean;
    connectToPeer: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    broadcast: ReturnType<typeof vi.fn>;
    becomeCoordinator: ReturnType<typeof vi.fn>;
  };
  flushPendingRoomRequests: ReturnType<typeof vi.fn>;
  applyStateSync: ReturnType<typeof vi.fn>;
  applyPatch: ReturnType<typeof vi.fn>;
  coordinatorRole: {
    claimIfVacant: ReturnType<typeof vi.fn>;
    announceTo: ReturnType<typeof vi.fn>;
    handleDeparture: ReturnType<typeof vi.fn>;
    isHolder: ReturnType<typeof vi.fn>;
  };
}

function makeHarness(): Harness {
  const transport = {
    isCoordinator: false,
    connectToPeer: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    broadcast: vi.fn().mockResolvedValue(undefined),
    becomeCoordinator: vi.fn().mockResolvedValue(undefined),
  };
  const flushPendingRoomRequests = vi.fn().mockResolvedValue(undefined);
  const applyStateSync =
    vi.fn<PeerLifecycleDeps["deliveryEngine"]["applyStateSync"]>();
  const applyPatch = vi.fn().mockResolvedValue(undefined);
  const notifyRoomsOfStatus = vi.fn().mockResolvedValue(undefined);
  const broadcastPatch = vi.fn().mockResolvedValue(undefined);
  const coordinatorRole = {
    claimIfVacant: vi.fn().mockResolvedValue(undefined),
    announceTo: vi.fn().mockResolvedValue(undefined),
    handleDeparture: vi.fn().mockResolvedValue(undefined),
    isHolder: vi.fn().mockReturnValue(false),
  };
  const deps: PeerLifecycleDeps = {
    peerInfo: new Map(),
    agents: new Map(),
    coordinatorPort: COORDINATOR_PORT,
    getPeerId: () => OWNER_ID,
    getCoordinatorPeerId: () => undefined,
    requireTransport: () => transport as never,
    serialise: () => emptyState(),
    roomProtocol: { flushPendingRoomRequests },
    deliveryEngine: {
      applyStateSync,
      applyPatch,
      notifyRoomsOfStatus,
      broadcastPatch,
    },
    coordinatorRole,
  };
  return {
    deps,
    lifecycle: new PeerLifecycle(deps),
    transport,
    flushPendingRoomRequests,
    applyStateSync,
    applyPatch,
    coordinatorRole,
  };
}

describe("PeerLifecycle — handlePeerList", () => {
  it("records every peer and dials each one except itself", () => {
    const h = makeHarness();
    const self = peerInfo(OWNER_ID);
    const other = peerInfo("other-peer");
    h.lifecycle.handlePeerList([self, other]);

    expect(h.deps.peerInfo.get(OWNER_ID)).toEqual(self);
    expect(h.deps.peerInfo.get("other-peer")).toEqual(other);
    expect(h.transport.connectToPeer).toHaveBeenCalledTimes(1);
    expect(h.transport.connectToPeer).toHaveBeenCalledWith(other, OWNER_ID);
  });
});

describe("PeerLifecycle — handlePeerJoined", () => {
  it("records the joining peer and dials it when it isn't this store's own id", () => {
    const h = makeHarness();
    const other = peerInfo("other-peer");
    h.lifecycle.handlePeerJoined(other);

    expect(h.deps.peerInfo.get("other-peer")).toEqual(other);
    expect(h.transport.connectToPeer).toHaveBeenCalledWith(other, OWNER_ID);
  });

  it("records but never dials itself when the joined peer is this store's own id", () => {
    const h = makeHarness();
    const self = peerInfo(OWNER_ID);
    h.lifecycle.handlePeerJoined(self);

    expect(h.deps.peerInfo.get(OWNER_ID)).toEqual(self);
    expect(h.transport.connectToPeer).not.toHaveBeenCalled();
  });
});

describe("PeerLifecycle — handlePeerConnected", () => {
  it("sends a state_sync when this store already has agent state", async () => {
    const h = makeHarness();
    h.deps.agents.set(OWNER_ID, { id: OWNER_ID } as AgentIdentity);

    await h.lifecycle.handlePeerConnected({ id: "conn-1" }, peerInfo("x"));

    expect(h.transport.send).toHaveBeenCalledWith(
      { id: "conn-1" },
      { method: "state_sync", state: emptyState() },
    );
  });

  it("sends no state_sync when this store has no agent state at all", async () => {
    const h = makeHarness();

    await h.lifecycle.handlePeerConnected({ id: "conn-1" }, peerInfo("x"));

    expect(h.transport.send).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ method: "state_sync" }),
    );
  });

  it("shares every known peer over the connection as a peer_list, so the mesh forms without a coordinator's handout (agent-comms#341)", async () => {
    const h = makeHarness();
    const self = peerInfo(OWNER_ID);
    const other = peerInfo("other-peer");
    h.deps.peerInfo.set(OWNER_ID, self);
    h.deps.peerInfo.set("other-peer", other);

    await h.lifecycle.handlePeerConnected({ id: "conn-1" }, peerInfo("x"));

    expect(h.transport.send).toHaveBeenCalledWith(
      { id: "conn-1" },
      { method: "peer_list", peers: [self, other] },
    );
  });

  it("always flushes pending room requests for the connection, regardless of state", async () => {
    const h = makeHarness();
    await h.lifecycle.handlePeerConnected({ id: "conn-1" }, peerInfo("x"));
    expect(h.flushPendingRoomRequests).toHaveBeenCalledWith("conn-1");
  });
});

describe("PeerLifecycle — handleDataMessage", () => {
  it("applies a normalised state_sync to the delivery engine", async () => {
    const h = makeHarness();
    await h.lifecycle.handleDataMessage(
      { id: "conn-1" },
      { method: "state_sync", state: emptyState() },
    );
    expect(h.applyStateSync).toHaveBeenCalledWith(emptyState());
  });

  it("applies a state_update's patch to the delivery engine", async () => {
    const h = makeHarness();
    const event: DeliveryEvent = {
      type: "connection_request",
      connectionId: "c",
      peerId: "p",
      dataPort: 1,
      name: "n",
      fingerprint: "fp",
    };
    await h.lifecycle.handleDataMessage(
      { id: "conn-1" },
      {
        method: "state_update",
        patch: { type: "delivery", agentId: "a", event },
      },
    );
    expect(h.applyPatch).toHaveBeenCalledWith({
      type: "delivery",
      agentId: "a",
      event,
    });
  });

  it("applies neither for a message method it doesn't dispatch on", async () => {
    const h = makeHarness();
    await h.lifecycle.handleDataMessage(
      { id: "conn-1" },
      { method: "introduce", peerId: "p", dataPort: 1 },
    );
    expect(h.applyStateSync).not.toHaveBeenCalled();
    expect(h.applyPatch).not.toHaveBeenCalled();
  });
});

describe("PeerLifecycle — handleBecomeCoordinator", () => {
  it("takes the port listener, replaces the peer table with exactly the handoff list, dials every peer, and claims the elected role only if no incumbent is known", async () => {
    const h = makeHarness();
    h.deps.peerInfo.set("stale-peer", peerInfo("stale-peer"));
    const incoming = [peerInfo("a"), peerInfo("b")];

    await h.lifecycle.handleBecomeCoordinator(incoming);

    expect(h.transport.becomeCoordinator).toHaveBeenCalledWith(
      "127.0.0.1",
      COORDINATOR_PORT,
    );
    expect(h.deps.peerInfo.has("stale-peer")).toBe(false);
    expect(h.deps.peerInfo.get("a")).toEqual(incoming[0]);
    expect(h.deps.peerInfo.get("b")).toEqual(incoming[1]);
    expect(h.transport.connectToPeer).toHaveBeenCalledTimes(2);
    expect(h.transport.connectToPeer).toHaveBeenCalledWith(
      incoming[0],
      OWNER_ID,
    );
    expect(h.transport.connectToPeer).toHaveBeenCalledWith(
      incoming[1],
      OWNER_ID,
    );
    expect(h.coordinatorRole.claimIfVacant).toHaveBeenCalledTimes(1);
  });
});

describe("PeerLifecycle — announcing the elected coordinator (agent-comms#341)", () => {
  it("announces the incumbent over every newly connected session", async () => {
    const h = makeHarness();
    const handle = { id: "new-peer" };

    await h.lifecycle.handlePeerConnected(handle, peerInfo("new-peer"));

    expect(h.coordinatorRole.announceTo).toHaveBeenCalledWith(handle);
  });

  it("announces the incumbent to a peer that introduced itself through the port", async () => {
    const h = makeHarness();
    const handle = { id: "joiner" };

    await h.lifecycle.handleIntroduction(handle, {
      peerId: "joiner",
      dataPort: 2,
    });

    expect(h.coordinatorRole.announceTo).toHaveBeenCalledWith(handle);
  });

  it("hands every departure to the elected role before anything else", async () => {
    const h = makeHarness();
    h.deps.peerInfo.set("gone", peerInfo("gone"));

    await h.lifecycle.handlePeerDeparture("gone");

    expect(h.coordinatorRole.handleDeparture).toHaveBeenCalledWith(
      "gone",
      expect.any(Function),
    );
    expect(h.deps.peerInfo.has("gone")).toBe(false);
  });
});

describe("PeerLifecycle — sendCoordinatorHandover", () => {
  it("does nothing when this side is not the coordinator", async () => {
    const h = makeHarness();
    h.transport.isCoordinator = false;
    h.deps.peerInfo.set(OWNER_ID, peerInfo(OWNER_ID));
    h.deps.peerInfo.set("other", peerInfo("other"));

    await h.lifecycle.sendCoordinatorHandover();

    expect(h.transport.send).not.toHaveBeenCalled();
    expect(h.transport.broadcast).not.toHaveBeenCalled();
  });

  it("does nothing when this side is the coordinator but no other peers remain", async () => {
    const h = makeHarness();
    h.transport.isCoordinator = true;
    h.deps.peerInfo.set(OWNER_ID, peerInfo(OWNER_ID));

    await h.lifecycle.sendCoordinatorHandover();

    expect(h.transport.send).not.toHaveBeenCalled();
  });

  it("sends become_coordinator to the longest-running remaining peer, carrying every other remaining peer", async () => {
    const h = makeHarness();
    h.transport.isCoordinator = true;
    h.deps.peerInfo.set(
      OWNER_ID,
      peerInfo(OWNER_ID, { startedAt: "2026-01-03T00:00:00.000Z" }),
    );
    const oldest = peerInfo("oldest", {
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    const middle = peerInfo("middle", {
      startedAt: "2026-01-02T00:00:00.000Z",
    });
    const newest = peerInfo("newest", {
      startedAt: "2026-01-04T00:00:00.000Z",
    });
    h.deps.peerInfo.set(oldest.id, oldest);
    h.deps.peerInfo.set(middle.id, middle);
    h.deps.peerInfo.set(newest.id, newest);

    await h.lifecycle.sendCoordinatorHandover();

    expect(h.transport.send).toHaveBeenCalledTimes(1);
    expect(h.transport.send).toHaveBeenCalledWith(
      { id: "oldest" },
      {
        method: "become_coordinator",
        peerList: expect.arrayContaining([middle, newest]) as PeerInfo[],
      },
    );
    const [, message] = h.transport.send.mock.calls[0] as [
      unknown,
      { peerList: PeerInfo[] },
    ];
    expect(message.peerList).toHaveLength(2);
  });

  it("picks the sole remaining peer as successor and sends an empty handoff list", async () => {
    const h = makeHarness();
    h.transport.isCoordinator = true;
    h.deps.peerInfo.set(OWNER_ID, peerInfo(OWNER_ID));
    const onlyPeer = peerInfo("only-peer");
    h.deps.peerInfo.set(onlyPeer.id, onlyPeer);

    await h.lifecycle.sendCoordinatorHandover();

    expect(h.transport.send).toHaveBeenCalledWith(
      { id: "only-peer" },
      { method: "become_coordinator", peerList: [] },
    );
  });
});

describe("PeerLifecycle — handlePeerDisconnected", () => {
  it("removes the disconnected peer's entry from peerInfo", () => {
    const h = makeHarness();
    h.deps.peerInfo.set("gone-peer", peerInfo("gone-peer"));
    h.lifecycle.handlePeerDisconnected({ id: "gone-peer" });
    expect(h.deps.peerInfo.has("gone-peer")).toBe(false);
  });
});

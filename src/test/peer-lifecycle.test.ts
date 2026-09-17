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

function peerInfo(id: string, port = 1): PeerInfo {
  return { id, port, startedAt: "2026-01-01T00:00:00.000Z" };
}

function emptyState(): SerialisedState {
  return { agents: {}, rooms: {}, messages: {}, dms: {}, deliveryQueues: {} };
}

interface Harness {
  deps: PeerLifecycleDeps;
  lifecycle: PeerLifecycle;
  transport: {
    connectToPeer: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    broadcast: ReturnType<typeof vi.fn>;
    becomeCoordinator: ReturnType<typeof vi.fn>;
  };
  flushPendingRoomRequests: ReturnType<typeof vi.fn>;
  applyStateSync: ReturnType<typeof vi.fn>;
  applyPatch: ReturnType<typeof vi.fn>;
  staleAgentCheckerStart: ReturnType<typeof vi.fn>;
  coordinatorGatewayOnBecameCoordinator: ReturnType<typeof vi.fn>;
  onCoordinatorRoleChanged: ReturnType<typeof vi.fn>;
}

function makeHarness(): Harness {
  const transport = {
    connectToPeer: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    broadcast: vi.fn().mockResolvedValue(undefined),
    becomeCoordinator: vi.fn().mockResolvedValue(undefined),
  };
  const flushPendingRoomRequests = vi.fn().mockResolvedValue(undefined);
  const applyStateSync =
    vi.fn<PeerLifecycleDeps["deliveryEngine"]["applyStateSync"]>();
  const applyPatch = vi.fn().mockResolvedValue(undefined);
  const staleAgentCheckerStart =
    vi.fn<PeerLifecycleDeps["staleAgentChecker"]["start"]>();
  const coordinatorGatewayOnBecameCoordinator = vi
    .fn<PeerLifecycleDeps["coordinatorGateway"]["onBecameCoordinator"]>()
    .mockResolvedValue(undefined);
  const onCoordinatorRoleChanged = vi
    .fn<NonNullable<PeerLifecycleDeps["onCoordinatorRoleChanged"]>>()
    .mockResolvedValue(undefined);
  const deps: PeerLifecycleDeps = {
    peerInfo: new Map(),
    agents: new Map(),
    coordinatorPort: COORDINATOR_PORT,
    getPeerId: () => OWNER_ID,
    requireTransport: () => transport as never,
    serialise: () => emptyState(),
    roomProtocol: { flushPendingRoomRequests },
    deliveryEngine: { applyStateSync, applyPatch },
    staleAgentChecker: { start: staleAgentCheckerStart },
    coordinatorGateway: {
      onBecameCoordinator: coordinatorGatewayOnBecameCoordinator,
    },
    onCoordinatorRoleChanged,
  };
  return {
    deps,
    lifecycle: new PeerLifecycle(deps),
    transport,
    flushPendingRoomRequests,
    applyStateSync,
    applyPatch,
    staleAgentCheckerStart,
    coordinatorGatewayOnBecameCoordinator,
    onCoordinatorRoleChanged,
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

    expect(h.transport.send).not.toHaveBeenCalled();
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
  it("becomes coordinator, replaces the peer table with exactly the handoff list, dials every peer, and starts stale-agent probing", async () => {
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
    expect(h.staleAgentCheckerStart).toHaveBeenCalledTimes(1);
    expect(h.coordinatorGatewayOnBecameCoordinator).toHaveBeenCalledTimes(1);
    expect(h.onCoordinatorRoleChanged).toHaveBeenCalledTimes(1);
  });

  it("still becomes coordinator when onCoordinatorRoleChanged is left unset", async () => {
    const h = makeHarness();
    h.deps.onCoordinatorRoleChanged = undefined;

    await expect(
      h.lifecycle.handleBecomeCoordinator([peerInfo("a")]),
    ).resolves.toBeUndefined();
    expect(h.transport.becomeCoordinator).toHaveBeenCalledTimes(1);
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

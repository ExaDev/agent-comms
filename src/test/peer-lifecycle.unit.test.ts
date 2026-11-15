/**
 * Direct, DI-based unit tests for PeerLifecycle -- it was previously exercised only indirectly through end-to-end mesh integration tests, leaving several individual branches, self-connect guards, and handleDataMessage's method-dispatch branches unobserved. A few of the survivors Stryker reports against handleDataMessage's whole-suite timeout classification: emptying its body doesn't fail fast, it hangs some unrelated integration test waiting on state that never arrives, so a direct unit test that fails immediately on the same mutation converts a slow timeout into a fast, precise kill. PeerLifecycleDeps is a narrow, injectable surface built exactly for this direct testing.
 */
import { describe, expect, it, vi } from "vitest";
import {
  PeerLifecycle,
  type PeerLifecycleDeps,
} from "../core/peer-lifecycle.js";
import { KnownAgents } from "../core/known-agents.js";
import { MAX_AGENTS_PER_SOURCE } from "../core/state-intake.js";
import { ROOM_REQUEST_TIMEOUT_MS } from "../core/request-timeouts.js";
import type { AgentIdentity, DeliveryEvent } from "../core/types.js";
import type { PeerInfo, SerialisedState } from "../core/wire-protocol.js";

const OWNER_ID = "owner-device";
const COORDINATOR_ID = "coordinator-device";
const COORDINATOR_PORT = 19876;
const FIRST_CONTACT_PORT = 19877;
const REPEATS = 3;

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
  /** The time the lifecycle reads, in milliseconds. */
  clock: { now: number };
  /** The peer this side dialled as its coordinator. */
  dialled: { coordinator: string | undefined };
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
    claimIfVacantAfterWait: ReturnType<typeof vi.fn>;
    handleDeparture: ReturnType<typeof vi.fn>;
    isHolder: ReturnType<typeof vi.fn>;
    current: ReturnType<typeof vi.fn>;
    onHolderAccepted: ((holderId: string) => void) | undefined;
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
    claimIfVacantAfterWait: vi.fn(),
    handleDeparture: vi.fn().mockResolvedValue(undefined),
    isHolder: vi.fn().mockReturnValue(false),
    onHolderAccepted: undefined as ((holderId: string) => void) | undefined,
    current: vi.fn((): { term: number; holder: string } | undefined => ({
      term: 1,
      holder: COORDINATOR_ID,
    })),
  };
  const agents = new KnownAgents();
  const clock = { now: 0 };
  const dialled: { coordinator: string | undefined } = {
    coordinator: undefined,
  };
  const deps: PeerLifecycleDeps = {
    peerInfo: new Map(),
    agents,
    coordinatorPort: COORDINATOR_PORT,
    getPeerId: () => OWNER_ID,
    getCoordinatorPeerId: () => dialled.coordinator,
    now: () => clock.now,
    staleAgentChecker: {
      forget: (agentId) => {
        agents.delete(agentId);
      },
    },
    requireTransport: () => transport as never,
    serialise: () => emptyState(),
    roomProtocol: { flushPendingRoomRequests },
    deliveryEngine: {
      applyStateSync,
      applyPatch,
      notifyRoomsOfStatus,
      broadcastPatch,
      bump: <T extends { version: number }>(entity: T): T => {
        entity.version += 1;
        return entity;
      },
    },
    coordinatorRole,
  };
  return {
    deps,
    clock,
    dialled,
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

describe("PeerLifecycle — handlePeerUnreachable", () => {
  it("forgets a peer that could not be reached, and no other", () => {
    const h = makeHarness();
    const gone = peerInfo("gone");
    h.lifecycle.handlePeerList([gone, peerInfo("alive")]);

    h.lifecycle.handlePeerUnreachable(gone);

    expect(h.deps.peerInfo.has("gone")).toBe(false);
    expect(h.deps.peerInfo.has("alive")).toBe(true);
  });

  it("keeps an entry that was refreshed after the failed dial was started", () => {
    const h = makeHarness();
    const dialled = peerInfo("moved", { port: 1 });
    h.lifecycle.handlePeerList([dialled]);
    const refreshed = peerInfo("moved", { port: 2 });
    h.lifecycle.handlePeerList([refreshed]);

    h.lifecycle.handlePeerUnreachable(dialled);

    expect(h.deps.peerInfo.get("moved")).toBe(refreshed);
  });

  it("does not retire an agent or touch the coordinator role: the peer was never connected", () => {
    const h = makeHarness();
    const gone = peerInfo("gone");
    h.lifecycle.handlePeerList([gone]);

    h.lifecycle.handlePeerUnreachable(gone);

    expect(h.coordinatorRole.handleDeparture).not.toHaveBeenCalled();
    expect(h.transport.becomeCoordinator).not.toHaveBeenCalled();
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

  it("gives a connected peer only its own agent when it is not the coordinator, and the whole state when it is", async () => {
    const h = makeHarness();
    const own = { id: OWNER_ID, name: "me", version: 1 } as AgentIdentity;
    const other = { id: "other", name: "them", version: 1 } as AgentIdentity;
    h.deps.agents.set(OWNER_ID, own);
    h.deps.serialise = () => ({
      ...emptyState(),
      agents: { [OWNER_ID]: own, other },
    });

    await h.lifecycle.handlePeerConnected({ id: "conn-1" }, peerInfo("x"));
    expect(h.transport.send).toHaveBeenCalledWith(
      { id: "conn-1" },
      expect.objectContaining({
        method: "state_sync",
        state: expect.objectContaining({ agents: { [OWNER_ID]: own } }),
      }),
    );

    h.transport.send.mockClear();
    h.transport.isCoordinator = true;
    await h.lifecycle.handlePeerConnected({ id: "conn-2" }, peerInfo("y"));
    expect(h.transport.send).toHaveBeenCalledWith(
      { id: "conn-2" },
      expect.objectContaining({
        state: expect.objectContaining({ agents: { [OWNER_ID]: own, other } }),
      }),
    );

    h.transport.send.mockClear();
    h.transport.isCoordinator = false;
    h.coordinatorRole.isHolder.mockReturnValue(true);
    await h.lifecycle.handlePeerConnected({ id: "conn-3" }, peerInfo("z"));
    expect(h.transport.send).toHaveBeenCalledWith(
      { id: "conn-3" },
      expect.objectContaining({
        state: expect.objectContaining({ agents: { [OWNER_ID]: own, other } }),
      }),
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

  function named(id: string, name = "worker"): AgentIdentity {
    return { id, name, version: 1 } as AgentIdentity;
  }

  function stateOf(...agents: readonly AgentIdentity[]): SerialisedState {
    return {
      ...emptyState(),
      agents: Object.fromEntries(agents.map((a) => [a.id, a])),
    };
  }

  it("keeps from a peer's snapshot the agent of its own store and not an agent it names for another, so a forged record is never held or sent on", async () => {
    const h = makeHarness();
    await h.lifecycle.handleDataMessage(
      { id: "peer-a" },
      {
        method: "state_sync",
        state: stateOf(named("peer-a"), named("peer-b")),
      },
    );
    expect(h.applyStateSync).toHaveBeenCalledWith(stateOf(named("peer-a")));
  });

  it("keeps the agents of other stores from the coordinator, which relays them", async () => {
    const h = makeHarness();
    await h.lifecycle.handleDataMessage(
      { id: COORDINATOR_ID },
      {
        method: "state_sync",
        state: stateOf(named(COORDINATOR_ID), named("peer-b")),
      },
    );
    expect(h.applyStateSync).toHaveBeenCalledWith(
      stateOf(named(COORDINATOR_ID), named("peer-b")),
    );
  });

  it("reports by count that records were refused, and names no record", async () => {
    const h = makeHarness();
    const errors: Error[] = [];
    h.deps.onError = (error) => {
      errors.push(error);
    };
    await h.lifecycle.handleDataMessage(
      { id: "peer-a" },
      { method: "state_sync", state: stateOf(named("peer-b")) },
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("refused 1 record");
    expect(errors[0]?.message).not.toContain("peer-b");
  });

  it("does not apply an agent update about another store from a peer that is not the coordinator", async () => {
    const h = makeHarness();
    await h.lifecycle.handleDataMessage(
      { id: "peer-a" },
      {
        method: "state_update",
        patch: { type: "agent_upsert", agent: named("peer-b") },
      },
    );
    expect(h.applyPatch).not.toHaveBeenCalled();
  });

  it("does not apply an offline report about another store from a peer that is not the coordinator", async () => {
    const h = makeHarness();
    await h.lifecycle.handleDataMessage(
      { id: "peer-a" },
      {
        method: "state_update",
        patch: { type: "agent_offline", agentId: "peer-b" },
      },
    );
    expect(h.applyPatch).not.toHaveBeenCalled();
  });

  it("applies an agent update from the agent's own store and from the coordinator", async () => {
    const h = makeHarness();
    await h.lifecycle.handleDataMessage(
      { id: "peer-a" },
      {
        method: "state_update",
        patch: { type: "agent_upsert", agent: named("peer-a") },
      },
    );
    await h.lifecycle.handleDataMessage(
      { id: COORDINATOR_ID },
      {
        method: "state_update",
        patch: { type: "agent_upsert", agent: named("peer-b") },
      },
    );
    expect(h.applyPatch).toHaveBeenCalledTimes(2);
  });

  it("reports a refusal once for a peer, however many it sends", async () => {
    const h = makeHarness();
    const errors: Error[] = [];
    h.deps.onError = (error) => {
      errors.push(error);
    };
    for (let n = 0; n < REPEATS; n++) {
      await h.lifecycle.handleDataMessage(
        { id: "peer-a" },
        { method: "state_sync", state: stateOf(named(`other-${String(n)}`)) },
      );
    }
    await h.lifecycle.handleDataMessage(
      { id: "peer-c" },
      { method: "state_sync", state: stateOf(named("other-x")) },
    );
    expect(errors).toHaveLength(2);
  });

  it("applies an offline report about this store's own agent from any peer, so the store can contradict it", async () => {
    const h = makeHarness();
    await h.lifecycle.handleDataMessage(
      { id: "peer-a" },
      {
        method: "state_update",
        patch: { type: "agent_offline", agentId: OWNER_ID },
      },
    );
    expect(h.applyPatch).toHaveBeenCalledTimes(1);
  });

  it("takes an offline record of this store's own agent in a snapshot from any peer, and not a running one", async () => {
    const h = makeHarness();
    h.deps.agents.set(OWNER_ID, named(OWNER_ID));
    await h.lifecycle.handleDataMessage(
      { id: "peer-a" },
      {
        method: "state_sync",
        state: stateOf({ ...named(OWNER_ID), status: "offline" }),
      },
    );
    expect(h.applyStateSync).toHaveBeenLastCalledWith(
      stateOf({ ...named(OWNER_ID), status: "offline" }),
    );
    await h.lifecycle.handleDataMessage(
      { id: "peer-a" },
      { method: "state_sync", state: stateOf(named(OWNER_ID)) },
    );
    expect(h.applyStateSync).toHaveBeenLastCalledWith(emptyState());
  });

  it("takes foreign agent records from the coordinator this side dialled, and from no other peer", async () => {
    const h = makeHarness();
    h.dialled.coordinator = "dialled";
    await h.lifecycle.handleDataMessage(
      { id: "dialled" },
      { method: "state_sync", state: stateOf(named("peer-b")) },
    );
    expect(h.applyStateSync).toHaveBeenLastCalledWith(stateOf(named("peer-b")));

    await h.lifecycle.handleDataMessage(
      { id: "not-dialled" },
      { method: "state_sync", state: stateOf(named("peer-c")) },
    );
    expect(h.applyStateSync).toHaveBeenLastCalledWith(emptyState());
  });

  it("counts the agents a connection introduced against that connection, whatever host the peer list names for it, so a rewritten peer entry moves nothing", async () => {
    const h = makeHarness();
    const relay = async (
      from: string,
      ...agents: readonly AgentIdentity[]
    ): Promise<void> => {
      await h.lifecycle.handleDataMessage(
        { id: from },
        { method: "state_sync", state: stateOf(...agents) },
      );
    };
    h.dialled.coordinator = "relayer";
    h.deps.peerInfo.set("victim", { ...peerInfo("victim"), host: "10.0.0.9" });
    for (let n = 0; n < MAX_AGENTS_PER_SOURCE; n++) {
      await relay("relayer", named(`fake-${String(n)}`));
      h.deps.agents.set(`fake-${String(n)}`, named(`fake-${String(n)}`));
    }

    // The relayer now has its own peer entry rewritten to the victim's host, and the victim's entry is rewritten to the relayer's.
    h.deps.peerInfo.set("relayer", {
      ...peerInfo("relayer"),
      host: "10.0.0.9",
    });
    await relay("relayer", named("one-too-many"));
    expect(h.applyStateSync).toHaveBeenLastCalledWith(emptyState());

    await relay("victim", named("victim"));
    expect(h.applyStateSync).toHaveBeenLastCalledWith(stateOf(named("victim")));
  });

  describe("what a sender gives before its claim is accepted", () => {
    const departure = {
      method: "state_update",
      patch: { type: "agent_offline", agentId: "gone" },
    } as const;

    it("applies a departure once the claim is accepted, and once", async () => {
      const h = makeHarness();
      await h.lifecycle.handleDataMessage({ id: "successor" }, departure);
      expect(h.applyPatch).not.toHaveBeenCalled();

      h.lifecycle.handleHolderAccepted("successor");
      await vi.waitFor(() => {
        expect(h.applyPatch).toHaveBeenCalledWith(departure.patch);
      });

      h.lifecycle.handleHolderAccepted("successor");
      expect(h.applyPatch).toHaveBeenCalledTimes(1);
    });

    it("applies the foreign agent records of a snapshot once the claim is accepted, which the joiner would otherwise lose", async () => {
      const h = makeHarness();
      await h.lifecycle.handleDataMessage(
        { id: "successor" },
        {
          method: "state_sync",
          state: stateOf(named("peer-b"), named("peer-c")),
        },
      );
      expect(h.applyStateSync).toHaveBeenLastCalledWith(emptyState());

      h.lifecycle.handleHolderAccepted("successor");

      expect(h.applyStateSync).toHaveBeenLastCalledWith(
        stateOf(named("peer-b"), named("peer-c")),
      );
    });

    it("applies an agent update once the claim is accepted", async () => {
      const h = makeHarness();
      await h.lifecycle.handleDataMessage(
        { id: "successor" },
        {
          method: "state_update",
          patch: { type: "agent_upsert", agent: named("peer-b") },
        },
      );
      expect(h.applyPatch).not.toHaveBeenCalled();

      h.lifecycle.handleHolderAccepted("successor");

      expect(h.applyStateSync).toHaveBeenLastCalledWith(
        stateOf(named("peer-b")),
      );
    });

    it("holds no record that is malformed, since no claim makes it acceptable", async () => {
      const h = makeHarness();
      await h.lifecycle.handleDataMessage(
        { id: "successor" },
        {
          method: "state_sync",
          state: stateOf(named("peer-b", "bad\u001b[2J")),
        },
      );

      h.lifecycle.handleHolderAccepted("successor");

      expect(h.applyStateSync).toHaveBeenCalledTimes(1);
    });

    it("drops what it holds when a claim naming another peer is accepted first", async () => {
      const h = makeHarness();
      await h.lifecycle.handleDataMessage({ id: "successor" }, departure);
      await h.lifecycle.handleDataMessage(
        { id: "successor" },
        { method: "state_sync", state: stateOf(named("peer-b")) },
      );

      h.lifecycle.handleHolderAccepted("someone-else");
      h.lifecycle.handleHolderAccepted("successor");

      expect(h.applyPatch).not.toHaveBeenCalled();
      expect(h.applyStateSync).toHaveBeenCalledTimes(1);
    });

    it("does not apply a departure about an agent whose record changed since it was held", async () => {
      const h = makeHarness();
      h.deps.agents.set("gone", { ...named("gone"), version: 1 });
      await h.lifecycle.handleDataMessage({ id: "successor" }, departure);
      h.deps.agents.set("gone", { ...named("gone"), version: 2 });

      h.lifecycle.handleHolderAccepted("successor");

      expect(h.applyPatch).not.toHaveBeenCalled();
    });

    it("does not apply what it held for longer than one claim wait", async () => {
      const h = makeHarness();
      await h.lifecycle.handleDataMessage({ id: "successor" }, departure);
      await h.lifecycle.handleDataMessage(
        { id: "successor" },
        { method: "state_sync", state: stateOf(named("peer-b")) },
      );
      h.clock.now += ROOM_REQUEST_TIMEOUT_MS + 1;

      h.lifecycle.handleHolderAccepted("successor");

      expect(h.applyPatch).not.toHaveBeenCalled();
      expect(h.applyStateSync).toHaveBeenCalledTimes(1);
    });

    it("holds afresh what arrives after an earlier hold expired, and applies it", async () => {
      const h = makeHarness();
      await h.lifecycle.handleDataMessage({ id: "successor" }, departure);
      h.clock.now += ROOM_REQUEST_TIMEOUT_MS + 1;
      await h.lifecycle.handleDataMessage(
        { id: "successor" },
        { method: "state_sync", state: stateOf(named("peer-b")) },
      );

      h.lifecycle.handleHolderAccepted("successor");

      expect(h.applyPatch).not.toHaveBeenCalled();
      expect(h.applyStateSync).toHaveBeenLastCalledWith(
        stateOf(named("peer-b")),
      );
    });

    it("applies what it held within one claim wait", async () => {
      const h = makeHarness();
      await h.lifecycle.handleDataMessage({ id: "successor" }, departure);
      h.clock.now += ROOM_REQUEST_TIMEOUT_MS;

      h.lifecycle.handleHolderAccepted("successor");

      await vi.waitFor(() => {
        expect(h.applyPatch).toHaveBeenCalledTimes(1);
      });
    });

    it("takes the announcement of a holder through the hook it gives the coordinator role", async () => {
      const h = makeHarness();
      await h.lifecycle.handleDataMessage({ id: "successor" }, departure);

      h.coordinatorRole.onHolderAccepted?.("successor");

      await vi.waitFor(() => {
        expect(h.applyPatch).toHaveBeenCalledTimes(1);
      });
    });

    it("forgets what it holds when the sender leaves", async () => {
      const h = makeHarness();
      await h.lifecycle.handleDataMessage({ id: "successor" }, departure);
      await h.lifecycle.handlePeerDeparture("successor");
      h.lifecycle.handleHolderAccepted("successor");
      expect(h.applyPatch).not.toHaveBeenCalled();
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

describe("PeerLifecycle and the elected coordinator (agent-comms#341)", () => {
  it("claims the role at once after binding the port when no first-contact presence could reach anyone else", async () => {
    const h = makeHarness();

    await h.lifecycle.handleBecomeCoordinator([]);

    expect(h.coordinatorRole.claimIfVacant).toHaveBeenCalledTimes(1);
    expect(h.coordinatorRole.claimIfVacantAfterWait).not.toHaveBeenCalled();
  });

  it("waits for an incumbent's announcement before claiming after binding the port when first contact may reach an existing holder", async () => {
    const h = makeHarness();
    h.deps.firstContactPort = FIRST_CONTACT_PORT;

    await h.lifecycle.handleBecomeCoordinator([]);

    expect(h.coordinatorRole.claimIfVacantAfterWait).toHaveBeenCalledTimes(1);
    expect(h.coordinatorRole.claimIfVacant).not.toHaveBeenCalled();
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

  it.each(["not a timestamp", ""])(
    "never picks a peer whose start time does not parse (%j) as the longest-running one",
    async (unreadable) => {
      const h = makeHarness();
      h.transport.isCoordinator = true;
      h.deps.peerInfo.set(OWNER_ID, peerInfo(OWNER_ID));
      h.deps.peerInfo.set(
        "unreadable",
        peerInfo("unreadable", { startedAt: unreadable }),
      );
      h.deps.peerInfo.set(
        "readable",
        peerInfo("readable", { startedAt: "2026-06-01T00:00:00.000Z" }),
      );

      await h.lifecycle.sendCoordinatorHandover();

      expect(h.transport.send).toHaveBeenCalledWith(
        { id: "readable" },
        expect.objectContaining({ method: "become_coordinator" }),
      );
    },
  );

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

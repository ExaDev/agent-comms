/**
 * Direct, DI-based unit tests for FederationBridge -- it was previously exercised only indirectly through end-to-end federation.integration.test.ts scenarios, leaving many individual branches, the fed:-prefix startsWith-vs-endsWith distinction, and getVisibleAgents/getFederatedRoomMemberships' filtering unobserved. FederationBridgeDeps is a narrow, injectable surface built exactly for this: a fake deps object with vi.fn() collaborators lets every branch be asserted on directly.
 */
import { describe, expect, it, vi } from "vitest";
import {
  FederationBridge,
  type FederationBridgeDeps,
} from "../core/federation-bridge.js";
import type { AgentIdentity, Room, RoomMessage } from "../core/types.js";

function agent(overrides: Partial<AgentIdentity> = {}): AgentIdentity {
  return {
    id: "local-agent",
    version: 1,
    name: "agent-name",
    harness: "pi",
    cwd: "/tmp",
    pid: 111,
    startedAt: "2026-01-01T00:00:00.000Z",
    visibility: "visible",
    status: "active",
    tags: [],
    subscribedRooms: [],
    ...overrides,
  };
}

function room(overrides: Partial<Room> = {}): Room {
  return {
    id: "room-1",
    version: 1,
    name: "room-name",
    type: "public",
    owner: "owner-device",
    createdAt: "2026-01-01T00:00:00.000Z",
    description: "",
    members: [],
    invited: [],
    memberJoins: {},
    memberLeaves: {},
    invitedJoins: {},
    invitedLeaves: {},
    ...overrides,
  };
}

function message(overrides: Partial<RoomMessage> = {}): RoomMessage {
  return {
    id: "msg-1",
    from: "sender",
    room: "room-1",
    content: "hi",
    timestamp: "2026-01-01T00:00:00.000Z",
    readBy: [],
    ...overrides,
  };
}

interface Harness {
  deps: FederationBridgeDeps;
  bridge: FederationBridge;
  bump: ReturnType<typeof vi.fn>;
  recordMemberOp: ReturnType<typeof vi.fn>;
  refreshMembership: ReturnType<typeof vi.fn>;
  broadcastPatch: ReturnType<typeof vi.fn>;
  deliverToRoom: ReturnType<typeof vi.fn>;
  deliverLocallyAndBroadcast: ReturnType<typeof vi.fn>;
}

function makeHarness(): Harness {
  const bump = vi.fn();
  const recordMemberOp =
    vi.fn<FederationBridgeDeps["deliveryEngine"]["recordMemberOp"]>();
  const refreshMembership =
    vi.fn<FederationBridgeDeps["deliveryEngine"]["refreshMembership"]>();
  const broadcastPatch = vi.fn().mockResolvedValue(undefined);
  const deliverToRoom = vi.fn().mockResolvedValue(undefined);
  const deliverLocallyAndBroadcast = vi.fn().mockResolvedValue(undefined);
  const deps: FederationBridgeDeps = {
    agents: new Map(),
    rooms: new Map(),
    messages: new Map(),
    deliveryEngine: {
      bump,
      recordMemberOp,
      refreshMembership,
      broadcastPatch,
      deliverToRoom,
      deliverLocallyAndBroadcast,
    },
  };
  return {
    deps,
    bridge: new FederationBridge(deps),
    bump,
    recordMemberOp,
    refreshMembership,
    broadcastPatch,
    deliverToRoom,
    deliverLocallyAndBroadcast,
  };
}

describe("FederationBridge — onAgentVisible", () => {
  it("stores the remote agent under a fed:<id>@<harness> key, tagged federated, and broadcasts it", async () => {
    const h = makeHarness();
    const remote = agent({ id: "remote-id", harness: "codex", tags: ["x"] });

    await h.bridge.onAgentVisible(remote);

    const stored = h.deps.agents.get("fed:remote-id@codex");
    expect(stored).toBeDefined();
    expect(stored?.id).toBe("fed:remote-id@codex");
    expect(stored?.tags).toEqual(["x", "federated"]);
    expect(h.broadcastPatch).toHaveBeenCalledWith({
      type: "agent_upsert",
      agent: stored,
    });
  });
});

describe("FederationBridge — onAgentGone", () => {
  it("marks the matching fed:-prefixed local agent offline and broadcasts it", async () => {
    const h = makeHarness();
    h.deps.agents.set(
      "fed:remote-id@codex",
      agent({ id: "fed:remote-id@codex", status: "active" }),
    );

    await h.bridge.onAgentGone("remote-id");

    expect(h.deps.agents.get("fed:remote-id@codex")?.status).toBe("offline");
    expect(h.broadcastPatch).toHaveBeenCalledWith({
      type: "agent_offline",
      agentId: "fed:remote-id@codex",
    });
  });

  it("does nothing when no local agent matches the fed:<id>@ prefix", async () => {
    const h = makeHarness();
    await h.bridge.onAgentGone("no-such-remote");
    expect(h.broadcastPatch).not.toHaveBeenCalled();
  });

  it("requires the prefix to actually match at the start, not merely appear at the end", async () => {
    const h = makeHarness();
    // Ends with "fed:remote-id@" but does not start with it -- must not match.
    h.deps.agents.set(
      "xfed:remote-id@",
      agent({ id: "xfed:remote-id@", status: "active" }),
    );

    await h.bridge.onAgentGone("remote-id");

    expect(h.deps.agents.get("xfed:remote-id@")?.status).toBe("active");
    expect(h.broadcastPatch).not.toHaveBeenCalled();
  });
});

describe("FederationBridge — onRoomMessage", () => {
  it("stores the message and delivers it to every local room member", async () => {
    const h = makeHarness();
    h.deps.rooms.set(
      "room-1",
      room({ id: "room-1", federated: true, members: ["a", "b"] }),
    );
    const msg = message();

    await h.bridge.onRoomMessage("room-1", msg);

    expect(h.deps.messages.get("room-1")).toEqual([msg]);
    expect(h.deliverLocallyAndBroadcast).toHaveBeenCalledWith("a", {
      type: "room_message",
      message: msg,
    });
    expect(h.deliverLocallyAndBroadcast).toHaveBeenCalledWith("b", {
      type: "room_message",
      message: msg,
    });
  });

  it("does nothing for a room that isn't federated", async () => {
    const h = makeHarness();
    h.deps.rooms.set("room-1", room({ id: "room-1", federated: false }));

    await h.bridge.onRoomMessage("room-1", message());

    expect(h.deps.messages.get("room-1")).toBeUndefined();
    expect(h.deliverLocallyAndBroadcast).not.toHaveBeenCalled();
  });
});

describe("FederationBridge — onRoomJoin", () => {
  it("adds a fed:-prefixed shadow member, records the join, and broadcasts the room when the member is new", async () => {
    const h = makeHarness();
    h.deps.rooms.set(
      "room-1",
      room({ id: "room-1", federated: true, members: [] }),
    );

    await h.bridge.onRoomJoin("room-1", "remote-agent", "Remote Name");

    expect(h.bump).toHaveBeenCalledTimes(1);
    expect(h.recordMemberOp).toHaveBeenCalledWith(
      expect.anything(),
      "member",
      "join",
      "fed:remote-agent",
    );
    expect(h.refreshMembership).toHaveBeenCalledTimes(1);
    expect(h.broadcastPatch).toHaveBeenCalledWith({
      type: "room_upsert",
      room: expect.anything(),
    });
  });

  it("skips the join-recording step entirely when the shadow member is already present", async () => {
    const h = makeHarness();
    h.deps.rooms.set(
      "room-1",
      room({ id: "room-1", federated: true, members: ["fed:remote-agent"] }),
    );

    await h.bridge.onRoomJoin("room-1", "remote-agent", "Remote Name");

    expect(h.bump).not.toHaveBeenCalled();
    expect(h.recordMemberOp).not.toHaveBeenCalled();
    expect(h.broadcastPatch).not.toHaveBeenCalled();
  });

  it("always notifies local members of the join, even when the shadow member already existed", async () => {
    const h = makeHarness();
    h.deps.rooms.set(
      "room-1",
      room({ id: "room-1", federated: true, members: ["fed:remote-agent"] }),
    );

    await h.bridge.onRoomJoin("room-1", "remote-agent", "Remote Name");

    expect(h.deliverToRoom).toHaveBeenCalledWith(
      "room-1",
      { type: "member_joined", room: "room-1", agent: "fed:remote-agent" },
      "fed:remote-agent",
    );
  });

  it("does nothing at all for a room that isn't federated", async () => {
    const h = makeHarness();
    h.deps.rooms.set("room-1", room({ id: "room-1", federated: false }));

    await h.bridge.onRoomJoin("room-1", "remote-agent", "Remote Name");

    expect(h.bump).not.toHaveBeenCalled();
    expect(h.deliverToRoom).not.toHaveBeenCalled();
  });
});

describe("FederationBridge — onRoomLeave", () => {
  it("records the leave, bumps and broadcasts the room, and notifies local members", async () => {
    const h = makeHarness();
    h.deps.rooms.set(
      "room-1",
      room({ id: "room-1", federated: true, members: ["fed:remote-agent"] }),
    );

    await h.bridge.onRoomLeave("room-1", "remote-agent");

    expect(h.bump).toHaveBeenCalledTimes(1);
    expect(h.recordMemberOp).toHaveBeenCalledWith(
      expect.anything(),
      "member",
      "leave",
      "fed:remote-agent",
    );
    expect(h.broadcastPatch).toHaveBeenCalledWith({
      type: "room_upsert",
      room: expect.anything(),
    });
    expect(h.deliverToRoom).toHaveBeenCalledWith("room-1", {
      type: "member_left",
      room: "room-1",
      agent: "fed:remote-agent",
    });
  });

  it("does nothing at all for a room that isn't federated", async () => {
    const h = makeHarness();
    h.deps.rooms.set("room-1", room({ id: "room-1", federated: false }));

    await h.bridge.onRoomLeave("room-1", "remote-agent");

    expect(h.bump).not.toHaveBeenCalled();
    expect(h.deliverToRoom).not.toHaveBeenCalled();
  });
});

describe("FederationBridge — getVisibleAgents", () => {
  it("includes a visible, non-federated agent", () => {
    const h = makeHarness();
    const a = agent({ id: "local-a", visibility: "visible" });
    h.deps.agents.set(a.id, a);
    expect(h.bridge.getVisibleAgents()).toEqual([a]);
  });

  it("excludes an agent that isn't visible", () => {
    const h = makeHarness();
    h.deps.agents.set(
      "hidden-a",
      agent({ id: "hidden-a", visibility: "hidden" }),
    );
    expect(h.bridge.getVisibleAgents()).toEqual([]);
  });

  it("excludes an already-federated-in agent even when visible", () => {
    const h = makeHarness();
    h.deps.agents.set(
      "fed:remote@codex",
      agent({ id: "fed:remote@codex", visibility: "visible" }),
    );
    expect(h.bridge.getVisibleAgents()).toEqual([]);
  });

  it("requires the fed: prefix to be at the start, not merely present at the end", () => {
    const h = makeHarness();
    // Ends with "fed:" but does not start with it -- must be included.
    const a = agent({ id: "xxxfed:", visibility: "visible" });
    h.deps.agents.set(a.id, a);
    expect(h.bridge.getVisibleAgents()).toEqual([a]);
  });
});

describe("FederationBridge — getFederatedRoomMemberships", () => {
  it("includes only federated rooms, with fed:-prefixed members filtered out", () => {
    const h = makeHarness();
    h.deps.rooms.set(
      "fed-room",
      room({
        id: "fed-room",
        federated: true,
        members: ["local-a", "fed:remote-b"],
      }),
    );
    h.deps.rooms.set(
      "plain-room",
      room({ id: "plain-room", federated: false, members: ["local-c"] }),
    );

    const result = h.bridge.getFederatedRoomMemberships();

    expect(result.get("fed-room")).toEqual(["local-a"]);
    expect(result.has("plain-room")).toBe(false);
  });

  it("requires the fed: prefix to be at the start, not merely present at the end, when filtering members", () => {
    const h = makeHarness();
    h.deps.rooms.set(
      "fed-room",
      room({ id: "fed-room", federated: true, members: ["xxxfed:"] }),
    );

    const result = h.bridge.getFederatedRoomMemberships();

    expect(result.get("fed-room")).toEqual(["xxxfed:"]);
  });
});

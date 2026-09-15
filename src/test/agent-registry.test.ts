/**
 * Direct, DI-based unit tests for AgentRegistry -- it was previously exercised only indirectly through MeshStore/room-kick-revocation integration tests, which left many individual branches, string literals, and array literals unobserved. AgentRegistryDeps is a narrow, injectable surface built exactly for this: a fake deps object with vi.fn() collaborators lets every branch be asserted on directly.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentRegistry,
  type AgentRegistryDeps,
} from "../core/agent-registry.js";
import { CommsError } from "../core/store.js";
import type { AgentIdentity } from "../core/types.js";

const OWNER_ID = "owner-device";
const OTHER_ID = "other-device";
const STARTED_AT = "2026-01-01T00:00:00.000Z";
/** An arbitrary, distinctive pid used only to prove updateAgent's patch actually lands -- no significance beyond "not the seeded pid". */
const UPDATED_PID = 999;

function agent(overrides: Partial<AgentIdentity> = {}): AgentIdentity {
  return {
    id: OWNER_ID,
    version: 1,
    name: "agent-name",
    harness: "pi",
    cwd: "/tmp",
    pid: 111,
    startedAt: STARTED_AT,
    visibility: "visible",
    status: "active",
    tags: [],
    subscribedRooms: [],
    ...overrides,
  };
}

interface Harness {
  deps: AgentRegistryDeps;
  registry: AgentRegistry;
  bump: ReturnType<typeof vi.fn>;
  broadcastPatch: ReturnType<typeof vi.fn>;
  notifyRoomsOfStatus: ReturnType<typeof vi.fn>;
  notifyRoomsOfNameChange: ReturnType<typeof vi.fn>;
  broadcastAgentVisible: ReturnType<typeof vi.fn>;
  broadcastAgentGone: ReturnType<typeof vi.fn>;
}

function makeHarness(peerId = OWNER_ID): Harness {
  const bump = vi.fn();
  const broadcastPatch = vi.fn().mockResolvedValue(undefined);
  const notifyRoomsOfStatus = vi.fn().mockResolvedValue(undefined);
  const notifyRoomsOfNameChange = vi.fn().mockResolvedValue(undefined);
  const broadcastAgentVisible = vi.fn().mockResolvedValue(undefined);
  const broadcastAgentGone = vi.fn().mockResolvedValue(undefined);
  const deps: AgentRegistryDeps = {
    agents: new Map(),
    identityCache: new Map(),
    startedAt: STARTED_AT,
    getPeerId: () => peerId,
    deliveryEngine: {
      bump,
      broadcastPatch,
      notifyRoomsOfStatus,
      notifyRoomsOfNameChange,
    },
    federation: { broadcastAgentVisible, broadcastAgentGone },
  };
  return {
    deps,
    registry: new AgentRegistry(deps),
    bump,
    broadcastPatch,
    notifyRoomsOfStatus,
    notifyRoomsOfNameChange,
    broadcastAgentVisible,
    broadcastAgentGone,
  };
}

describe("AgentRegistry — identity cache", () => {
  it("readIdentity keys by the exact harness+cwd pair, not a blank or partial key", async () => {
    const { registry, deps } = makeHarness();
    deps.identityCache.set("pi--/tmp/a", { id: "agent-a" });
    deps.identityCache.set("codex--/tmp/a", { id: "agent-b" });

    await expect(registry.readIdentity("pi", "/tmp/a")).resolves.toEqual({
      id: "agent-a",
    });
    await expect(registry.readIdentity("codex", "/tmp/a")).resolves.toEqual({
      id: "agent-b",
    });
    await expect(
      registry.readIdentity("pi", "/tmp/other"),
    ).resolves.toBeUndefined();
  });

  it("writeIdentity stores under the harness+cwd composite key, readable back by readIdentity", async () => {
    const { registry } = makeHarness();
    await registry.writeIdentity("pi", "/tmp/a", "written-id");
    await expect(registry.readIdentity("pi", "/tmp/a")).resolves.toEqual({
      id: "written-id",
    });
  });
});

describe("AgentRegistry — registerAgent", () => {
  it("a brand-new (harness, cwd) pair creates a fresh agent with an empty subscribedRooms array", async () => {
    const { registry, deps } = makeHarness();
    const created = await registry.registerAgent({
      name: "fresh",
      harness: "pi",
      cwd: "/tmp/fresh",
      pid: 1,
      visibility: "visible",
      tags: ["x"],
    });

    expect(created.subscribedRooms).toEqual([]);
    expect(deps.agents.get(OWNER_ID)).toEqual(created);
    await expect(registry.readIdentity("pi", "/tmp/fresh")).resolves.toEqual({
      id: OWNER_ID,
    });
  });

  it("re-registering an already-known (harness, cwd) pair updates the existing agent by its original id rather than minting a fresh one", async () => {
    let nextId = 0;
    const peerIds = ["first-id", "second-id"];
    const { registry, deps } = makeHarness();
    deps.getPeerId = () => {
      const id = peerIds[nextId];
      nextId += 1;
      if (id === undefined)
        throw new Error("getPeerId called more times than expected");
      return id;
    };

    const first = await registry.registerAgent({
      name: "one",
      harness: "pi",
      cwd: "/tmp/same",
      pid: 1,
      visibility: "visible",
      tags: [],
    });
    const second = await registry.registerAgent({
      name: "two",
      harness: "pi",
      cwd: "/tmp/same",
      pid: 2,
      visibility: "hidden",
      tags: ["updated"],
    });

    expect(second.id).toBe(first.id);
    expect(nextId).toBe(1);
    expect(second.name).toBe("two");
    expect(second.visibility).toBe("hidden");
    expect(second.pid).toBe(2);
    expect(second.tags).toEqual(["updated"]);
  });

  it("broadcasts presence to federated links only for a visible agent, not hidden or ghost", async () => {
    const visible = makeHarness();
    await visible.registry.registerAgent({
      name: "v",
      harness: "pi",
      cwd: "/tmp/v",
      pid: 1,
      visibility: "visible",
      tags: [],
    });
    expect(visible.broadcastAgentVisible).toHaveBeenCalledTimes(1);

    const hidden = makeHarness();
    await hidden.registry.registerAgent({
      name: "h",
      harness: "pi",
      cwd: "/tmp/h",
      pid: 1,
      visibility: "hidden",
      tags: [],
    });
    expect(hidden.broadcastAgentVisible).not.toHaveBeenCalled();

    const ghost = makeHarness();
    await ghost.registry.registerAgent({
      name: "g",
      harness: "pi",
      cwd: "/tmp/g",
      pid: 1,
      visibility: "ghost",
      tags: [],
    });
    expect(ghost.broadcastAgentVisible).not.toHaveBeenCalled();
  });
});

describe("AgentRegistry — getAgent", () => {
  it("returns the stored agent for a known id, undefined for an unknown one", async () => {
    const { registry, deps } = makeHarness();
    const a = agent();
    deps.agents.set(a.id, a);
    await expect(registry.getAgent(a.id)).resolves.toEqual(a);
    await expect(registry.getAgent("nobody")).resolves.toBeUndefined();
  });
});

describe("AgentRegistry — updateAgent", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
    h.deps.agents.set(OWNER_ID, agent({ name: "old-name", status: "active" }));
  });

  it("throws a CommsError naming the exact missing agent id when the target doesn't exist", async () => {
    await expect(
      h.registry.updateAgent("missing-id", {}),
    ).rejects.toMatchObject(
      new CommsError("Agent missing-id not found", "AGENT_NOT_FOUND"),
    );
  });

  it("bumps and persists the merged patch into the agents map", async () => {
    const updated = await h.registry.updateAgent(OWNER_ID, {
      pid: UPDATED_PID,
    });
    expect(h.bump).toHaveBeenCalledWith(updated);
    expect(h.deps.agents.get(OWNER_ID)).toEqual(updated);
    expect(updated.pid).toBe(UPDATED_PID);
  });

  it("notifies rooms of a name change only when the patch actually changes the name", async () => {
    await h.registry.updateAgent(OWNER_ID, { name: "new-name" });
    expect(h.notifyRoomsOfNameChange).toHaveBeenCalledWith(
      OWNER_ID,
      "old-name",
      "new-name",
    );
  });

  it("does not notify of a name change when the patch omits name", async () => {
    await h.registry.updateAgent(OWNER_ID, { pid: 1 });
    expect(h.notifyRoomsOfNameChange).not.toHaveBeenCalled();
  });

  it("does not notify of a name change when the patch repeats the current name", async () => {
    await h.registry.updateAgent(OWNER_ID, { name: "old-name" });
    expect(h.notifyRoomsOfNameChange).not.toHaveBeenCalled();
  });

  it("notifies rooms of a status change only when the patch actually changes the status", async () => {
    await h.registry.updateAgent(OWNER_ID, { status: "offline" });
    expect(h.notifyRoomsOfStatus).toHaveBeenCalledWith(OWNER_ID, "offline");
  });

  it("does not notify of a status change when the patch omits status", async () => {
    await h.registry.updateAgent(OWNER_ID, { pid: 1 });
    expect(h.notifyRoomsOfStatus).not.toHaveBeenCalled();
  });

  it("does not notify of a status change when the patch repeats the current status", async () => {
    await h.registry.updateAgent(OWNER_ID, { status: "active" });
    expect(h.notifyRoomsOfStatus).not.toHaveBeenCalled();
  });
});

describe("AgentRegistry — listAgents", () => {
  it("excludes a ghost agent from a different requester's view", async () => {
    const { registry, deps } = makeHarness();
    deps.agents.set(
      "ghost-agent",
      agent({ id: "ghost-agent", visibility: "ghost" }),
    );
    deps.agents.set(
      "visible-agent",
      agent({ id: "visible-agent", visibility: "visible" }),
    );

    const result = await registry.listAgents("some-requester");
    expect(result.map((a) => a.id)).toEqual(["visible-agent"]);
  });

  it("includes a ghost agent in its own view of itself", async () => {
    const { registry, deps } = makeHarness();
    deps.agents.set(
      "ghost-agent",
      agent({ id: "ghost-agent", visibility: "ghost" }),
    );

    const result = await registry.listAgents("ghost-agent");
    expect(result.map((a) => a.id)).toEqual(["ghost-agent"]);
  });

  it("always includes a non-ghost agent regardless of who's asking", async () => {
    const { registry, deps } = makeHarness();
    deps.agents.set(
      "visible-agent",
      agent({ id: "visible-agent", visibility: "visible" }),
    );

    const result = await registry.listAgents("anyone-else");
    expect(result.map((a) => a.id)).toEqual(["visible-agent"]);
  });
});

describe("AgentRegistry — setAgentOffline", () => {
  it("is a no-op for an unknown agent id", async () => {
    const h = makeHarness();
    await h.registry.setAgentOffline("unknown");
    expect(h.bump).not.toHaveBeenCalled();
  });

  it("is a no-op for an agent already offline", async () => {
    const h = makeHarness();
    h.deps.agents.set(OWNER_ID, agent({ status: "offline" }));
    await h.registry.setAgentOffline(OWNER_ID);
    expect(h.bump).not.toHaveBeenCalled();
    expect(h.notifyRoomsOfStatus).not.toHaveBeenCalled();
  });

  it("for the owning peer's own agent, sets status offline, bumps, persists, and broadcasts to rooms/mesh/federation", async () => {
    const h = makeHarness(OWNER_ID);
    h.deps.agents.set(OWNER_ID, agent({ status: "active" }));

    await h.registry.setAgentOffline(OWNER_ID);

    expect(h.deps.agents.get(OWNER_ID)?.status).toBe("offline");
    expect(h.bump).toHaveBeenCalledTimes(1);
    expect(h.notifyRoomsOfStatus).toHaveBeenCalledWith(OWNER_ID, "offline");
    expect(h.broadcastPatch).toHaveBeenCalledWith({
      type: "agent_offline",
      agentId: OWNER_ID,
    });
    expect(h.broadcastAgentGone).toHaveBeenCalledWith(OWNER_ID);
  });

  it("for a non-owning peer's agent, updates local state but does not broadcast anything", async () => {
    const h = makeHarness(OWNER_ID);
    h.deps.agents.set(OTHER_ID, agent({ id: OTHER_ID, status: "active" }));

    await h.registry.setAgentOffline(OTHER_ID);

    expect(h.deps.agents.get(OTHER_ID)?.status).toBe("offline");
    expect(h.bump).toHaveBeenCalledTimes(1);
    expect(h.notifyRoomsOfStatus).not.toHaveBeenCalled();
    expect(h.broadcastPatch).not.toHaveBeenCalled();
    expect(h.broadcastAgentGone).not.toHaveBeenCalled();
  });
});

/**
 * Direct, DI-based unit tests for AgentRegistry -- it was previously exercised only indirectly through MeshStore/room-kick-revocation integration tests, which left many individual branches, string literals, and array literals unobserved. AgentRegistryDeps is a narrow, injectable surface built exactly for this: a fake deps object with vi.fn() collaborators lets every branch be asserted on directly.
 *
 * One mutant Stryker raises against setAgentOffline is a true equivalent, not a gap -- documented here rather than chased with a contrived test, matching stale-agent-checker.test.ts's own precedent for the identical pattern: `this.deps.agents.set(id, agent)` right after `agent.status = "offline"` re-sets the same key to the exact same object reference `this.deps.agents.get(id)` already returned, so mutating `.status` on it has already mutated what the Map holds. No test can observe removing that call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentRegistry,
  type AgentRegistryDeps,
} from "../core/agent-registry.js";
import { CommsError } from "../core/store.js";
import { DEFAULT_PRESENCE_STALE_AFTER_MS } from "../core/gossip-extensions.js";
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
}

function makeHarness(peerId = OWNER_ID): Harness {
  const bump = vi.fn();
  const broadcastPatch = vi.fn().mockResolvedValue(undefined);
  const notifyRoomsOfStatus = vi.fn().mockResolvedValue(undefined);
  const notifyRoomsOfNameChange = vi.fn().mockResolvedValue(undefined);
  const deps: AgentRegistryDeps = {
    agents: new Map(),
    identityCache: new Map(),
    startedAt: STARTED_AT,
    getPeerId: () => peerId,
    requireTransport: () =>
      ({ listKnownDevices: undefined }) as unknown as ReturnType<
        AgentRegistryDeps["requireTransport"]
      >,
    presenceStaleAfterMs: DEFAULT_PRESENCE_STALE_AFTER_MS,
    deliveryEngine: {
      bump,
      broadcastPatch,
      notifyRoomsOfStatus,
      notifyRoomsOfNameChange,
    },
  };
  return {
    deps,
    registry: new AgentRegistry(deps),
    bump,
    broadcastPatch,
    notifyRoomsOfStatus,
    notifyRoomsOfNameChange,
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
});

describe("AgentRegistry — getAgent", () => {
  it("returns the stored agent for a known id, undefined for an unknown one", async () => {
    const { registry, deps } = makeHarness();
    const a = agent();
    deps.agents.set(a.id, a);
    await expect(registry.getAgent(a.id)).resolves.toEqual(a);
    await expect(registry.getAgent("nobody")).resolves.toBeUndefined();
  });

  it("falls back to a gossip-discovered device not locally registered, as the same placeholder shape listAgents synthesises (agent-comms#155: a remote, hub-learned agent never lands in deps.agents at all)", async () => {
    const { registry, deps } = makeHarness();
    deps.requireTransport = () =>
      ({
        listKnownDevices: () => [
          {
            deviceId: "remote-device",
            advert: {
              "agent/self": {
                name: "remote-agent",
                harness: "codex",
                cwd: "/tmp/remote",
                pid: 42,
                startedAt: "2026-03-03T00:00:00.000Z",
                tags: ["from-hub"],
                subscribedRooms: [],
              },
              "presence/status": "idle",
            },
          },
        ],
      }) as unknown as ReturnType<AgentRegistryDeps["requireTransport"]>;

    await expect(registry.getAgent("remote-device")).resolves.toMatchObject({
      id: "remote-device",
      name: "remote-agent",
      harness: "codex",
      cwd: "/tmp/remote",
      pid: 42,
      visibility: "visible",
      status: "idle",
      tags: ["from-hub"],
    });
  });

  it("prefers a locally-known agent over a same-id gossip-discovered placeholder", async () => {
    const { registry, deps } = makeHarness();
    const local = agent({ id: "dual-known", name: "local-copy" });
    deps.agents.set(local.id, local);
    deps.requireTransport = () =>
      ({
        listKnownDevices: () => [
          {
            deviceId: "dual-known",
            advert: {
              "agent/self": {
                name: "stale-gossip-copy",
                harness: "codex",
                cwd: "/tmp",
                pid: 1,
                startedAt: "2026-01-01T00:00:00.000Z",
                tags: [],
                subscribedRooms: [],
              },
            },
          },
        ],
      }) as unknown as ReturnType<AgentRegistryDeps["requireTransport"]>;

    await expect(registry.getAgent("dual-known")).resolves.toEqual(local);
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

  it("merges in a gossip-discovered agent not otherwise locally known, as a placeholder-shaped AgentIdentity", async () => {
    const { registry, deps } = makeHarness();
    deps.requireTransport = () =>
      ({
        listKnownDevices: () => [
          {
            deviceId: "discovered-device",
            advert: {
              "agent/self": {
                name: "discovered-agent",
                harness: "codex",
                cwd: "/tmp/discovered",
                pid: 7,
                startedAt: "2026-02-02T00:00:00.000Z",
                tags: ["from-gossip"],
                subscribedRooms: [],
              },
              "presence/status": "busy",
            },
          },
        ],
      }) as unknown as ReturnType<AgentRegistryDeps["requireTransport"]>;

    const result = await registry.listAgents("some-requester");
    const discovered = result.find((a) => a.id === "discovered-device");
    expect(discovered).toMatchObject({
      id: "discovered-device",
      name: "discovered-agent",
      harness: "codex",
      cwd: "/tmp/discovered",
      pid: 7,
      startedAt: "2026-02-02T00:00:00.000Z",
      visibility: "visible",
      status: "busy",
      tags: ["from-gossip"],
      subscribedRooms: [],
    });
  });

  it("never lets a gossip-discovered agent shadow an agent this store already knows locally", async () => {
    const { registry, deps } = makeHarness();
    deps.agents.set(
      "already-known",
      agent({ id: "already-known", name: "real-agent" }),
    );
    deps.requireTransport = () =>
      ({
        listKnownDevices: () => [
          {
            deviceId: "already-known",
            advert: {
              "agent/self": {
                name: "stale-gossip-copy",
                harness: "codex",
                cwd: "/tmp",
                pid: 1,
                startedAt: "2026-01-01T00:00:00.000Z",
                tags: [],
                subscribedRooms: [],
              },
            },
          },
        ],
      }) as unknown as ReturnType<AgentRegistryDeps["requireTransport"]>;

    const result = await registry.listAgents("some-requester");
    expect(result.filter((a) => a.id === "already-known")).toHaveLength(1);
    expect(result.find((a) => a.id === "already-known")?.name).toBe(
      "real-agent",
    );
  });

  it("ignores a transport with no listKnownDevices capability, matching every construction site that predates this feature", async () => {
    const { registry, deps } = makeHarness();
    deps.agents.set(
      "visible-agent",
      agent({ id: "visible-agent", visibility: "visible" }),
    );
    const result = await registry.listAgents("anyone-else");
    expect(result.map((a) => a.id)).toEqual(["visible-agent"]);
  });
});

describe("AgentRegistry — gossip-discovered presence staleness (agent-comms#301)", () => {
  const NOW_MS = new Date("2026-06-01T00:00:00.000Z").getTime();
  const MS_PER_SECOND = 1000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A discovered-device advert whose snapshot-seconds is ageMs old as of NOW_MS, carrying whatever presence status (or none) the test passes. */
  function advertAgedMs(
    ageMs: number,
    presenceStatus?: string,
  ): Record<string, unknown> {
    return {
      "agent/self": {
        name: "discovered-agent",
        harness: "codex",
        cwd: "/tmp/discovered",
        pid: 7,
        startedAt: "2026-02-02T00:00:00.000Z",
        tags: [],
        subscribedRooms: [],
      },
      "snapshot-seconds": Math.floor((NOW_MS - ageMs) / MS_PER_SECOND),
      ...(presenceStatus !== undefined
        ? { "presence/status": presenceStatus }
        : {}),
    };
  }

  function withKnownDevice(
    deps: AgentRegistryDeps,
    advert: Record<string, unknown>,
  ): void {
    deps.requireTransport = () =>
      ({
        listKnownDevices: () => [{ deviceId: "discovered-device", advert }],
      }) as unknown as ReturnType<AgentRegistryDeps["requireTransport"]>;
  }

  it("trusts a fresh advert's own presence status", async () => {
    const { registry, deps } = makeHarness();
    withKnownDevice(deps, advertAgedMs(0, "busy"));

    const result = await registry.listAgents("some-requester");
    expect(result.find((a) => a.id === "discovered-device")?.status).toBe(
      "busy",
    );
  });

  it("still trusts the advert's own presence status exactly at the staleness boundary", async () => {
    const { registry, deps } = makeHarness();
    withKnownDevice(
      deps,
      advertAgedMs(DEFAULT_PRESENCE_STALE_AFTER_MS, "busy"),
    );

    const result = await registry.listAgents("some-requester");
    expect(result.find((a) => a.id === "discovered-device")?.status).toBe(
      "busy",
    );
  });

  it("reports offline once the advert is older than the staleness window, regardless of the presence status it carried", async () => {
    const { registry, deps } = makeHarness();
    withKnownDevice(
      deps,
      advertAgedMs(DEFAULT_PRESENCE_STALE_AFTER_MS + 1, "active"),
    );

    const result = await registry.listAgents("some-requester");
    expect(result.find((a) => a.id === "discovered-device")?.status).toBe(
      "offline",
    );
  });

  it("reports offline for a stale advert that never carried a presence status at all, rather than defaulting to active", async () => {
    const { registry, deps } = makeHarness();
    withKnownDevice(deps, advertAgedMs(DEFAULT_PRESENCE_STALE_AFTER_MS + 1));

    const result = await registry.listAgents("some-requester");
    expect(result.find((a) => a.id === "discovered-device")?.status).toBe(
      "offline",
    );
  });

  it("defaults a fresh advert with no presence status to active, unchanged from before agent-comms#301", async () => {
    const { registry, deps } = makeHarness();
    withKnownDevice(deps, advertAgedMs(0));

    const result = await registry.listAgents("some-requester");
    expect(result.find((a) => a.id === "discovered-device")?.status).toBe(
      "active",
    );
  });

  it("leaves staleness unjudged for an advert with no snapshot-seconds at all, trusting whatever presence status it carries", async () => {
    const { registry, deps } = makeHarness();
    const advert = advertAgedMs(0, "idle");
    delete advert["snapshot-seconds"];
    withKnownDevice(deps, advert);

    const result = await registry.listAgents("some-requester");
    expect(result.find((a) => a.id === "discovered-device")?.status).toBe(
      "idle",
    );
  });

  it("reads the staleness window from deps.presenceStaleAfterMs, not a hardcoded default", async () => {
    const SHORT_STALE_AFTER_MS = 5000;
    const { registry, deps } = makeHarness();
    deps.presenceStaleAfterMs = SHORT_STALE_AFTER_MS;
    withKnownDevice(deps, advertAgedMs(SHORT_STALE_AFTER_MS + 1, "active"));

    const result = await registry.listAgents("some-requester");
    expect(result.find((a) => a.id === "discovered-device")?.status).toBe(
      "offline",
    );
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

  it("for the owning peer's own agent, sets status offline, bumps, persists, and broadcasts to rooms/mesh", async () => {
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
  });

  it("for a non-owning peer's agent, updates local state but does not broadcast anything", async () => {
    const h = makeHarness(OWNER_ID);
    h.deps.agents.set(OTHER_ID, agent({ id: OTHER_ID, status: "active" }));

    await h.registry.setAgentOffline(OTHER_ID);

    expect(h.deps.agents.get(OTHER_ID)?.status).toBe("offline");
    expect(h.bump).toHaveBeenCalledTimes(1);
    expect(h.notifyRoomsOfStatus).not.toHaveBeenCalled();
    expect(h.broadcastPatch).not.toHaveBeenCalled();
  });
});

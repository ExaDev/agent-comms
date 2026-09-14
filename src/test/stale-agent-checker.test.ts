import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  StaleAgentChecker,
  type StaleAgentCheckerDeps,
} from "../core/stale-agent-checker.js";
import type { AgentIdentity, AgentStatus } from "../core/types.js";
import type { MeshStatePatch, PeerInfo } from "../core/wire-protocol.js";

const PROBE_INTERVAL_MS = 5000;
const OFFLINE_PURGE_THRESHOLD_MS = 30 * 60 * 1000;
const ALIVE_PID = 111;
const DEAD_PID = 222;
const FIXED_NOW_MS = 1_700_000_000_000;
// vi.advanceTimersByTimeAsync advances the mocked Date along with fake timers, so by the time a probe actually runs, Date.now() is FIXED_NOW_MS + however far the clock was advanced to fire it -- ages are computed relative to that real evaluation instant, not the clock's initial value, so a boundary test lands exactly where it claims to.
const PROBE_TIME_MS = FIXED_NOW_MS + PROBE_INTERVAL_MS;

function agent(
  id: string,
  status: AgentStatus,
  pid: number,
  startedAt: string,
): AgentIdentity {
  return {
    id,
    version: 1,
    name: id,
    harness: "pi",
    cwd: "/tmp",
    pid,
    startedAt,
    visibility: "visible",
    status,
    tags: [],
    subscribedRooms: [],
  };
}

function isoAgeMs(ageMs: number): string {
  return new Date(PROBE_TIME_MS - ageMs).toISOString();
}

interface Harness {
  deps: StaleAgentCheckerDeps;
  checker: StaleAgentChecker;
  notifyRoomsOfStatus: ReturnType<typeof vi.fn>;
  broadcastPatch: ReturnType<typeof vi.fn>;
}

function harness(agents: readonly AgentIdentity[]): Harness {
  const agentsMap = new Map(agents.map((a) => [a.id, a]));
  const deliveryQueues = new Map<string, never[]>();
  const identityCache = new Map<string, { id: string }>();
  const peerInfo = new Map<string, PeerInfo>();
  for (const a of agents) {
    deliveryQueues.set(a.id, []);
    identityCache.set(a.id, { id: a.id });
    peerInfo.set(a.id, { id: a.id, port: 1, startedAt: a.startedAt });
  }
  const notifyRoomsOfStatus = vi.fn(async (): Promise<void> =>
    Promise.resolve(),
  );
  const broadcastPatch = vi.fn(async (): Promise<void> => Promise.resolve());
  const deps: StaleAgentCheckerDeps = {
    agents: agentsMap,
    deliveryQueues: deliveryQueues,
    identityCache,
    peerInfo,
    notifyRoomsOfStatus,
    broadcastPatch: broadcastPatch,
  };
  return {
    deps,
    checker: new StaleAgentChecker(deps),
    notifyRoomsOfStatus,
    broadcastPatch,
  };
}

describe("StaleAgentChecker", () => {
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW_MS);
    killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation((pid: number): true => {
        if (pid === ALIVE_PID) return true;
        throw new Error("ESRCH");
      });
  });

  afterEach(() => {
    killSpy.mockRestore();
    vi.useRealTimers();
  });

  describe("start/stop", () => {
    it("does nothing until start() is called", async () => {
      const { checker, broadcastPatch } = harness([
        agent("a1", "active", DEAD_PID, isoAgeMs(0)),
      ]);
      await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS * 2);
      expect(broadcastPatch).not.toHaveBeenCalled();
      checker.stop();
    });

    it("probes on the configured interval once started", async () => {
      const { checker, broadcastPatch } = harness([
        agent("a1", "active", DEAD_PID, isoAgeMs(0)),
      ]);
      checker.start();
      await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS);
      expect(broadcastPatch).toHaveBeenCalledTimes(1);
      checker.stop();
    });

    it("calling start() twice does not create a second timer", async () => {
      const { checker, broadcastPatch } = harness([
        agent("a1", "active", DEAD_PID, isoAgeMs(0)),
      ]);
      checker.start();
      checker.start();
      await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS);
      // A second, uncancelled timer firing on the same schedule would double every call count.
      expect(broadcastPatch).toHaveBeenCalledTimes(1);
      checker.stop();
    });

    it("stop() halts further probing", async () => {
      const { checker, broadcastPatch } = harness([
        agent("a1", "active", DEAD_PID, isoAgeMs(0)),
      ]);
      checker.start();
      await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS);
      checker.stop();
      broadcastPatch.mockClear();
      await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS * 3);
      expect(broadcastPatch).not.toHaveBeenCalled();
    });

    it("stop() before start() is a safe no-op", () => {
      const { checker } = harness([]);
      expect(() => {
        checker.stop();
      }).not.toThrow();
    });
  });

  describe("dead-process detection", () => {
    it("marks an active agent with a dead pid offline, notifies, broadcasts, and drops its peer info", async () => {
      const { deps, checker, notifyRoomsOfStatus, broadcastPatch } = harness([
        agent("a1", "active", DEAD_PID, isoAgeMs(0)),
      ]);
      deps.peerInfo.set("a1", { id: "a1", port: 42, startedAt: isoAgeMs(0) });
      checker.start();
      await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS);
      checker.stop();

      expect(deps.agents.get("a1")?.status).toBe("offline");
      expect(notifyRoomsOfStatus).toHaveBeenCalledWith("a1", "offline");
      expect(broadcastPatch).toHaveBeenCalledWith({
        type: "agent_offline",
        agentId: "a1",
      });
      expect(deps.peerInfo.has("a1")).toBe(false);
    });

    it("leaves an active agent with a live pid untouched", async () => {
      const { deps, checker, notifyRoomsOfStatus, broadcastPatch } = harness([
        agent("a1", "active", ALIVE_PID, isoAgeMs(0)),
      ]);
      checker.start();
      await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS);
      checker.stop();

      expect(deps.agents.get("a1")?.status).toBe("active");
      expect(notifyRoomsOfStatus).not.toHaveBeenCalled();
      expect(broadcastPatch).not.toHaveBeenCalled();
      expect(deps.peerInfo.has("a1")).toBe(true);
    });

    it("does not re-probe an agent that is already offline, even with a dead pid", async () => {
      const { deps, checker, notifyRoomsOfStatus } = harness([
        agent("a1", "offline", DEAD_PID, isoAgeMs(0)),
      ]);
      checker.start();
      await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS);
      checker.stop();

      // Only the "status !== active" guard is exercised here -- the purge threshold (30 min) is far beyond isoAgeMs(0), so this agent is untouched by both code paths.
      expect(deps.agents.get("a1")?.status).toBe("offline");
      expect(notifyRoomsOfStatus).not.toHaveBeenCalled();
    });

    it("marks every dead active agent offline in a single probe pass", async () => {
      const { deps, checker, broadcastPatch } = harness([
        agent("a1", "active", DEAD_PID, isoAgeMs(0)),
        agent("a2", "active", DEAD_PID, isoAgeMs(0)),
        agent("a3", "active", ALIVE_PID, isoAgeMs(0)),
      ]);
      checker.start();
      await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS);
      checker.stop();

      expect(deps.agents.get("a1")?.status).toBe("offline");
      expect(deps.agents.get("a2")?.status).toBe("offline");
      expect(deps.agents.get("a3")?.status).toBe("active");
      expect(broadcastPatch).toHaveBeenCalledTimes(2);
    });
  });

  describe("offline-agent purging", () => {
    it("purges an agent offline for longer than the threshold, from every map", async () => {
      const { deps, checker } = harness([
        agent(
          "a1",
          "offline",
          DEAD_PID,
          isoAgeMs(OFFLINE_PURGE_THRESHOLD_MS + 1),
        ),
      ]);
      checker.start();
      await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS);
      checker.stop();

      expect(deps.agents.has("a1")).toBe(false);
      expect(deps.peerInfo.has("a1")).toBe(false);
      expect(deps.identityCache.has("a1")).toBe(false);
      expect(deps.deliveryQueues.has("a1")).toBe(false);
    });

    it("does not purge an offline agent still within the threshold", async () => {
      const { deps, checker } = harness([
        agent(
          "a1",
          "offline",
          DEAD_PID,
          isoAgeMs(OFFLINE_PURGE_THRESHOLD_MS - 1),
        ),
      ]);
      checker.start();
      await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS);
      checker.stop();

      expect(deps.agents.has("a1")).toBe(true);
    });

    it("does not purge a non-offline agent no matter how old its startedAt is", async () => {
      const { deps, checker } = harness([
        agent(
          "a1",
          "active",
          ALIVE_PID,
          isoAgeMs(OFFLINE_PURGE_THRESHOLD_MS * 10),
        ),
      ]);
      checker.start();
      await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS);
      checker.stop();

      expect(deps.agents.has("a1")).toBe(true);
    });

    it("purges every long-offline agent while leaving a recent one alone, in the same pass", async () => {
      const { deps, checker } = harness([
        agent(
          "old",
          "offline",
          DEAD_PID,
          isoAgeMs(OFFLINE_PURGE_THRESHOLD_MS + 1),
        ),
        agent(
          "recent",
          "offline",
          DEAD_PID,
          isoAgeMs(OFFLINE_PURGE_THRESHOLD_MS - 1),
        ),
      ]);
      checker.start();
      await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS);
      checker.stop();

      expect(deps.agents.has("old")).toBe(false);
      expect(deps.agents.has("recent")).toBe(true);
    });

    it("both marks a newly-dead agent offline and purges an already-long-offline one in the same probe", async () => {
      const { deps, checker } = harness([
        agent("newlyDead", "active", DEAD_PID, isoAgeMs(0)),
        agent(
          "longOffline",
          "offline",
          DEAD_PID,
          isoAgeMs(OFFLINE_PURGE_THRESHOLD_MS + 1),
        ),
      ]);
      checker.start();
      await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS);
      checker.stop();

      expect(deps.agents.get("newlyDead")?.status).toBe("offline");
      expect(deps.agents.has("longOffline")).toBe(false);
    });
  });
});

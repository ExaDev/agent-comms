/**
 * StaleAgentChecker — coordinator-only periodic liveness probe over every registered agent's own PID, marking a dead process's agent offline and, separately, purging agent records that have sat offline past a fixed threshold. Split out of MeshStore purely to keep mesh-store.ts under the repo's max-lines cap; owns its own probe-interval timer exclusively (nothing outside this class ever reads or writes it).
 */

import type { AgentIdentity, AgentStatus, DeliveryEvent } from "./types.js";
import type { MeshStatePatch, PeerInfo } from "./wire-protocol.js";

/** The state and collaborators StaleAgentChecker needs from MeshStore -- the core agent/delivery/peer/identity Maps it reads and mutates directly (shared references into MeshStore's own fields), plus the two DeliveryEngine operations a status change and an offline patch need to broadcast. */
export interface StaleAgentCheckerDeps {
  agents: Map<string, AgentIdentity>;
  deliveryQueues: Map<string, DeliveryEvent[]>;
  identityCache: Map<string, { id: string }>;
  peerInfo: Map<string, PeerInfo>;
  notifyRoomsOfStatus: (agentId: string, status: AgentStatus) => Promise<void>;
  broadcastPatch: (patch: MeshStatePatch) => Promise<void>;
}

/** How often the coordinator probes registered agent PIDs for liveness. */
const PROBE_INTERVAL_MS = 5000;

/** How long an agent may sit "offline" before its record is purged entirely, to prevent indefinite accumulation. */
const OFFLINE_PURGE_THRESHOLD_MINUTES = 30;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const OFFLINE_PURGE_THRESHOLD_MS =
  OFFLINE_PURGE_THRESHOLD_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND;

export class StaleAgentChecker {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: StaleAgentCheckerDeps) {}

  /** Starts the periodic probe (coordinator-only). No-op if already running. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.probeStaleAgents();
    }, PROBE_INTERVAL_MS);
  }

  /** Stops the periodic probe, if running. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async probeStaleAgents(): Promise<void> {
    const {
      agents,
      deliveryQueues,
      identityCache,
      peerInfo,
      notifyRoomsOfStatus,
      broadcastPatch,
    } = this.deps;
    const deadIds: string[] = [];

    for (const [id, agent] of agents) {
      if (agent.status !== "active") continue;
      if (!this.isProcessAlive(agent.pid)) {
        deadIds.push(id);
      }
    }

    for (const id of deadIds) {
      const agent = agents.get(id);
      if (agent) {
        agent.status = "offline";
        agents.set(id, agent);
        await notifyRoomsOfStatus(id, "offline");
      }
      await broadcastPatch({ type: "agent_offline", agentId: id });
      peerInfo.delete(id);
    }

    // Also purge long-offline agents to prevent indefinite accumulation.
    const offlineThreshold = Date.now() - OFFLINE_PURGE_THRESHOLD_MS;
    const purgeIds: string[] = [];
    for (const [id, agent] of agents) {
      if (agent.status !== "offline") continue;
      const startedAt = new Date(agent.startedAt).getTime();
      if (startedAt < offlineThreshold) {
        purgeIds.push(id);
      }
    }
    for (const id of purgeIds) {
      agents.delete(id);
      peerInfo.delete(id);
      identityCache.delete(id);
      deliveryQueues.delete(id);
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

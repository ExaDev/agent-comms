/**
 * AgentRegistry — the agent-identity half of CommsStore: the per-(harness, cwd) identity cache readIdentity/writeIdentity uses to recognise a restarted bridge as the same agent, and the register/get/update/list/offline lifecycle around an AgentIdentity record itself. Split out of mesh-store.ts to reduce it under the repo's max-lines cap.
 */

import { CommsError } from "./store.js";
import type { DeliveryEngine } from "./delivery-engine.js";
import type { FederationManager } from "./federation.js";
import type { AgentIdentity, Visibility } from "./types.js";

/** The state and collaborators AgentRegistry needs from MeshStore. agents/identityCache are direct references into MeshStore's own fields; startedAt is a readonly value copied once; deliveryEngine and federation are the already-constructed instances, narrowed to what agent-lifecycle bookkeeping ever needs. */
export interface AgentRegistryDeps {
  agents: Map<string, AgentIdentity>;
  identityCache: Map<string, { id: string }>;
  startedAt: string;
  getPeerId: () => string;
  deliveryEngine: Pick<
    DeliveryEngine,
    | "bump"
    | "broadcastPatch"
    | "notifyRoomsOfStatus"
    | "notifyRoomsOfNameChange"
  >;
  federation: Pick<
    FederationManager,
    "broadcastAgentVisible" | "broadcastAgentGone"
  >;
}

export class AgentRegistry {
  constructor(private readonly deps: AgentRegistryDeps) {}

  // -----------------------------------------------------------------------
  // CommsStore — Identity
  // -----------------------------------------------------------------------

  async readIdentity(
    harness: string,
    cwd: string,
  ): Promise<{ id: string } | undefined> {
    await Promise.resolve();
    return this.deps.identityCache.get(`${harness}--${cwd}`);
  }

  async writeIdentity(harness: string, cwd: string, id: string): Promise<void> {
    await Promise.resolve();
    this.deps.identityCache.set(`${harness}--${cwd}`, { id });
  }

  // -----------------------------------------------------------------------
  // CommsStore — Agent registry
  // -----------------------------------------------------------------------

  async registerAgent(opts: {
    name: string;
    harness: string;
    cwd: string;
    pid: number;
    visibility: Visibility;
    tags: string[];
  }): Promise<AgentIdentity> {
    const existing = await this.readIdentity(opts.harness, opts.cwd);
    if (existing) {
      return this.updateAgent(existing.id, {
        name: opts.name,
        visibility: opts.visibility,
        tags: opts.tags,
        status: "active",
        pid: opts.pid,
      });
    }

    const id = this.deps.getPeerId();
    const agent: AgentIdentity = {
      id,
      version: 1,
      name: opts.name,
      harness: opts.harness,
      cwd: opts.cwd,
      pid: opts.pid,
      startedAt: this.deps.startedAt,
      visibility: opts.visibility,
      status: "active",
      tags: opts.tags,
      subscribedRooms: [],
    };

    this.deps.agents.set(id, agent);
    await this.writeIdentity(opts.harness, opts.cwd, id);
    await this.deps.deliveryEngine.broadcastPatch({
      type: "agent_upsert",
      agent,
    });
    // Broadcast presence to federated links
    if (agent.visibility === "visible") {
      await this.deps.federation.broadcastAgentVisible(agent);
    }
    return agent;
  }

  async getAgent(id: string): Promise<AgentIdentity | undefined> {
    await Promise.resolve();
    return this.deps.agents.get(id);
  }

  async updateAgent(
    id: string,
    patch: Partial<
      Pick<AgentIdentity, "name" | "visibility" | "status" | "tags" | "pid">
    >,
  ): Promise<AgentIdentity> {
    const agent = this.deps.agents.get(id);
    if (!agent)
      throw new CommsError(`Agent ${id} not found`, "AGENT_NOT_FOUND");

    const oldStatus = agent.status;
    const oldName = agent.name;
    const updatedAgent: AgentIdentity = { ...agent, ...patch };
    this.deps.deliveryEngine.bump(updatedAgent);
    this.deps.agents.set(id, updatedAgent);
    await this.deps.deliveryEngine.broadcastPatch({
      type: "agent_upsert",
      agent: updatedAgent,
    });

    if (patch.name !== undefined && patch.name !== oldName) {
      await this.deps.deliveryEngine.notifyRoomsOfNameChange(
        id,
        oldName,
        patch.name,
      );
    }

    if (patch.status && patch.status !== oldStatus) {
      await this.deps.deliveryEngine.notifyRoomsOfStatus(id, patch.status);
    }

    return updatedAgent;
  }

  async listAgents(requesterId: string): Promise<AgentIdentity[]> {
    await Promise.resolve();
    const result: AgentIdentity[] = [];
    for (const agent of this.deps.agents.values()) {
      if (agent.visibility === "ghost" && agent.id !== requesterId) continue;
      result.push(agent);
    }
    return result;
  }

  async setAgentOffline(id: string): Promise<void> {
    const agent = this.deps.agents.get(id);
    if (!agent) return;
    if (agent.status === "offline") return;

    // Only the owning store should broadcast the status change. Other stores learn about it via the agent_offline mesh patch.
    const isOwner = id === this.deps.getPeerId();
    agent.status = "offline";
    this.deps.deliveryEngine.bump(agent);
    this.deps.agents.set(id, agent);

    if (isOwner) {
      await this.deps.deliveryEngine.notifyRoomsOfStatus(id, "offline");
      await this.deps.deliveryEngine.broadcastPatch({
        type: "agent_offline",
        agentId: id,
      });
      await this.deps.federation.broadcastAgentGone(id);
    }
  }
}

/**
 * AgentRegistry — the agent-identity half of CommsStore: the per-(harness, cwd) identity cache readIdentity/writeIdentity uses to recognise a restarted bridge as the same agent, and the register/get/update/list/offline lifecycle around an AgentIdentity record itself. Split out of mesh-store.ts to reduce it under the repo's max-lines cap.
 */

import { CommsError } from "./store.js";
import type { DeliveryEngine } from "./delivery-engine.js";
import type { MeshTransport } from "./transport.js";
import {
  AGENT_CARD_GOSSIP_KEY,
  AGENT_SELF_GOSSIP_KEY,
  type AgentCardAdvert,
  type AgentSelfAdvert,
} from "./gossip-extensions.js";
import { AgentStatus } from "./types.js";
import type {
  AgentIdentity,
  ListedAgent,
  RemoteAgentIdentity,
  Visibility,
} from "./types.js";

/** snapshot-seconds is epoch seconds (mesh-session.ts's own `Math.floor(clock.now() / 1000)`); presenceStatusFor compares it against Date.now(), which is milliseconds. */
const MS_PER_SECOND = 1000;

/** The state and collaborators AgentRegistry needs from MeshStore. agents/identityCache are direct references into MeshStore's own fields; startedAt is a readonly value copied once; deliveryEngine is the already-constructed instance, narrowed to what agent-lifecycle bookkeeping ever needs. */
export interface AgentRegistryDeps {
  agents: Map<string, AgentIdentity>;
  identityCache: Map<string, { id: string }>;
  startedAt: string;
  getPeerId: () => string;
  requireTransport: () => MeshTransport;
  /** How old a gossip-discovered device's own last-heard advert (its snapshot-seconds) may be before listDiscoverableAgents stops trusting whatever presence value it last carried and reports it offline instead (agent-comms#301). Defaults to DEFAULT_PRESENCE_STALE_AFTER_MS; MeshStore threads its own presenceStaleAfterMs constructor option through here. */
  presenceStaleAfterMs: number;
  deliveryEngine: Pick<
    DeliveryEngine,
    | "bump"
    | "broadcastPatch"
    | "notifyRoomsOfStatus"
    | "notifyRoomsOfNameChange"
  >;
}

/** Narrows an untrusted gossiped value (WireMeshTransport.listKnownDevices' own advert["agent/self"], self-asserted by whichever peer advertised it) into an AgentSelfAdvert -- a malformed or non-conforming entry is silently skipped rather than treated as an error, the same convention room-lifecycle.ts's own isHostedRoomAdvert already established for the identical class of gossip consumption. */
function isAgentSelfAdvert(value: unknown): value is AgentSelfAdvert {
  if (typeof value !== "object" || value === null) return false;
  if (!("name" in value) || typeof value.name !== "string") return false;
  if (!("harness" in value) || typeof value.harness !== "string") return false;
  if (!("cwd" in value) || typeof value.cwd !== "string") return false;
  if (!("pid" in value) || typeof value.pid !== "number") return false;
  if (!("startedAt" in value) || typeof value.startedAt !== "string")
    return false;
  if (!("tags" in value) || !Array.isArray(value.tags)) return false;
  if (!("subscribedRooms" in value) || !Array.isArray(value.subscribedRooms))
    return false;
  if ("membership" in value && typeof value.membership !== "string")
    return false;
  return true;
}

/** Narrows an untrusted gossiped value (a peer's own self-asserted `agent/card`, the advert a device sends through a hub) into an AgentCardAdvert. A malformed entry is skipped by the caller, as with isAgentSelfAdvert. */
function isAgentCardAdvert(value: unknown): value is AgentCardAdvert {
  if (typeof value !== "object" || value === null) return false;
  if (!("name" in value) || typeof value.name !== "string") return false;
  if (!("harness" in value) || typeof value.harness !== "string") return false;
  if (!("startedAt" in value) || typeof value.startedAt !== "string")
    return false;
  if (!("tags" in value) || !Array.isArray(value.tags)) return false;
  if ("membership" in value && typeof value.membership !== "string")
    return false;
  return true;
}

/** A device heard about through gossip, with what it told us about itself: everything on a private link, or only its card through a hub. */
type DiscoveredDevice = {
  deviceId: string;
  status: AgentStatus | undefined;
} & (
  | { self: AgentSelfAdvert; card?: never }
  | { card: AgentCardAdvert; self?: never }
);

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
    return agent;
  }

  /** Resolves an agent by id, falling back to a gossip-discovered device (see listDiscoverableAgents' own doc) not otherwise locally known -- the same merge listAgents already applies to its returned array, but for a single lookup rather than the whole list. This is what lets a caller resolve a remote, hub-learned agent (agent-comms#155) that will never appear in deps.agents at all, since nothing replicates full agent records cross-machine the way a local peer's agent_upsert broadcast does. */
  async getAgent(id: string): Promise<ListedAgent | undefined> {
    await Promise.resolve();
    const known = this.deps.agents.get(id);
    if (known !== undefined) return known;
    const discovered = this.listDiscoverableAgents().find(
      (candidate) => candidate.deviceId === id,
    );
    return discovered === undefined
      ? undefined
      : AgentRegistry.synthesiseDiscoveredAgent(discovered);
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

  async listAgents(requesterId: string): Promise<ListedAgent[]> {
    await Promise.resolve();
    const result: ListedAgent[] = [];
    for (const agent of this.deps.agents.values()) {
      if (agent.visibility === "ghost" && agent.id !== requesterId) continue;
      result.push(agent);
    }
    for (const discovered of this.listDiscoverableAgents()) {
      if (this.deps.agents.has(discovered.deviceId)) continue;
      result.push(AgentRegistry.synthesiseDiscoveredAgent(discovered));
    }
    return result;
  }

  /** Builds the record a gossip-discovered device (never locally registered) is represented as -- shared by listAgents' own array merge and getAgent's single-lookup fallback, so both resolve an identical shape for the identical device. A device heard about over a private link has told us where it runs and gets a full record; one heard about through a hub gave only its card and gets a reduced one. */
  private static synthesiseDiscoveredAgent(
    discovered: Readonly<DiscoveredDevice>,
  ): ListedAgent {
    if (discovered.self === undefined) {
      const reduced: RemoteAgentIdentity = {
        id: discovered.deviceId,
        version: 0,
        name: discovered.card.name,
        harness: discovered.card.harness,
        startedAt: discovered.card.startedAt,
        visibility: "visible",
        status: discovered.status ?? "active",
        tags: discovered.card.tags,
      };
      return reduced;
    }
    return {
      id: discovered.deviceId,
      version: 0,
      name: discovered.self.name,
      harness: discovered.self.harness,
      cwd: discovered.self.cwd,
      pid: discovered.self.pid,
      startedAt: discovered.self.startedAt,
      visibility: "visible",
      status: discovered.status ?? "active",
      tags: discovered.self.tags,
      subscribedRooms: discovered.self.subscribedRooms,
    };
  }

  /**
   * Every agent this store has heard gossiped by another device but never registered or otherwise locally recorded -- the read half of P3.8's eventual agent register/update/offline retirement (agent-comms#48), mirroring listRooms' own room-discovery merge (#138). Never merged into this.deps.agents: a gossip hint is not the same as a real registration, and this store has nothing else authoritative to report for it. Only ever an agent that gossiped itself as "visible" (MeshStore's own selfAgentAdvert getter never advertises a hidden or ghost agent this way), so no ghost-filtering is needed here the way listAgents' own local-agent check needs.
   *
   * A gossip-discovered device is never told its own advert has gone stale (agent-comms#301): nothing on the hub relays a lost connection to anyone but the two peers that held it, so the only signal this side has at all is whether the device's own last advert is still recent. A device whose snapshot-seconds is older than deps.presenceStaleAfterMs is reported offline regardless of whatever presence value that stale advert carried -- trusting a heartbeat that stopped arriving minutes ago is worse than reporting the honest "we don't know" that offline actually means here.
   */
  private listDiscoverableAgents(): readonly DiscoveredDevice[] {
    const transport = this.deps.requireTransport();
    if (transport.listKnownDevices === undefined) return [];
    const result: DiscoveredDevice[] = [];
    const now = Date.now();
    for (const { deviceId, advert } of transport.listKnownDevices()) {
      const status = this.presenceStatusFor(advert, now);
      const self = advert[AGENT_SELF_GOSSIP_KEY];
      if (isAgentSelfAdvert(self)) {
        result.push({ deviceId, status, self });
        continue;
      }
      const card = advert[AGENT_CARD_GOSSIP_KEY];
      if (isAgentCardAdvert(card)) result.push({ deviceId, status, card });
    }
    return result;
  }

  /** The status listDiscoverableAgents reports for one gossip-discovered device's own advert: offline once its snapshot-seconds is older than deps.presenceStaleAfterMs, whatever presence/status it last carried; the gossiped presence/status value when the advert is still fresh and carries one; undefined when it's fresh but never gossiped presence at all, leaving synthesiseDiscoveredAgent's own `?? "active"` to report the same "reachable, no status opinion" default this had before agent-comms#301. snapshot-seconds missing or not a finite number (an advert this malformed should not reach here in practice, since every real self-advert is signed and schema-validated before this side ever merges it, but advert itself is an untrusted `Record<string, unknown>` as far as this function's own types are concerned) leaves staleness unjudged rather than guessed at either extreme. */
  private presenceStatusFor(
    advert: Readonly<Record<string, unknown>>,
    now: number,
  ): AgentStatus | undefined {
    const snapshotSeconds = advert["snapshot-seconds"];
    if (
      typeof snapshotSeconds === "number" &&
      Number.isFinite(snapshotSeconds)
    ) {
      const ageMs = now - snapshotSeconds * MS_PER_SECOND;
      if (ageMs > this.deps.presenceStaleAfterMs) return "offline";
    }
    const status = advert["presence/status"];
    return AgentStatus.is(status) ? status : undefined;
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
    }
  }
}

/**
 * What a store takes from the state a peer sends it: a snapshot or a patch of agents, rooms, messages and the rest is checked at the wire boundary, before any of it reaches the delivery engine. A record of an agent is accepted only from the peer whose device id it names, or from the peer this side takes to be the coordinator, since an agent is its own store's peer and no other peer is the authority on it; the number of entries one snapshot may carry, and the number of agents a store keeps, are bounded. A report about the receiver's own agent is the exception: an offline report, or an offline record, is let through so the store can contradict it.
 */

import { parseDisplayName } from "./display-name.js";
import type { KnownAgents } from "./known-agents.js";
import type { AgentIdentity } from "./types.js";
import type { MeshStatePatch, SerialisedState } from "./wire-protocol.js";

/**
 * The most entries one snapshot may carry in any one of its collections (agents, rooms, message histories, direct-message histories, delivery queues). A machine's mesh holds a few agents per session that is open on it, so a few thousand is far above any real one, while one snapshot cannot make a store hold an unbounded amount.
 */
export const MAX_SNAPSHOT_ENTRIES = 4096;

/** The most agents a store keeps. Past it, a new agent takes the place of an offline record, and is refused only when no record is offline; one already known is still updated. At least the largest snapshot, so a full snapshot of a full mesh fits. */
export const MAX_KNOWN_AGENTS = 4096;

/** The most agents one origin may have introduced that a store still holds: the host a peer was reached at, or this machine for a peer reached on it, so a host that presents many device keys is still one origin. At this number an origin's new agent takes the place of that origin's own offline record, and is refused only when it has none. */
export const MAX_AGENTS_PER_ORIGIN = 512;

/** Who sent state, and whether this side takes that peer to be the coordinator. */
export interface StateSender {
  readonly id: string;
  readonly isCoordinator: boolean;
}

/** What the intake did with a message: what to apply, and how many records it refused. */
export interface Admitted<T> {
  readonly value: T;
  readonly refused: number;
}

/** What the intake did with a snapshot, and which refused agent records were refused only for want of the sender's authority, which a later claim can give it. */
export interface AdmittedSnapshot extends Admitted<SerialisedState> {
  readonly awaitingAuthority: readonly AgentIdentity[];
}

/** Whether `sender` may speak for the agent `agentId`: it is that agent's own store, or the coordinator. */
function mayDescribeAgent(sender: StateSender, agentId: string): boolean {
  return sender.id === agentId || sender.isCoordinator;
}

/** Whether a record is one a conforming peer sends: it sits under its own id and its name is one a registration would have kept as it is. */
export function isWellFormedAgent(
  key: string,
  agent: Readonly<AgentIdentity>,
): boolean {
  return (
    typeof agent.id === "string" &&
    agent.id === key &&
    typeof agent.name === "string" &&
    parseDisplayName(agent.name) === agent.name
  );
}

/** What a claim needs of the store's agent slots. */
interface ClaimSlots {
  has: (agentId: string) => boolean;
  size: number;
  heldFrom: (origin: string, keep: ReadonlySet<string>) => number;
  tag: (agentId: string, origin: string) => void;
  evictOne: (keep: ReadonlySet<string>, origin?: string) => boolean;
}

/** The claims on agent slots that the records of one message make. */
export class AgentClaims {
  private readonly claimed = new Set<string>();

  constructor(
    private readonly slots: Readonly<ClaimSlots>,
    private readonly origin: string,
  ) {}

  has(agentId: string): boolean {
    return this.slots.has(agentId);
  }

  /** Whether the store takes a record for `agentId`: it already holds one, or it can hold a new one. A new one counts against the origin that introduced it, and past the bound of the origin or of the store takes the place of an offline record. */
  claim(agentId: string): boolean {
    if (this.slots.has(agentId) || this.claimed.has(agentId)) return true;
    if (
      this.slots.heldFrom(this.origin, this.claimed) >= MAX_AGENTS_PER_ORIGIN &&
      !this.slots.evictOne(this.claimed, this.origin)
    ) {
      return false;
    }
    if (
      this.slots.size + this.claimed.size >= MAX_KNOWN_AGENTS &&
      !this.slots.evictOne(this.claimed)
    ) {
      return false;
    }
    this.claimed.add(agentId);
    this.slots.tag(agentId, this.origin);
    return true;
  }
}

/** What an AgentSlots reads of, and does to, the store. */
export interface AgentSlotsStore {
  readonly agents: KnownAgents;
  /** Forgets everything the store holds for an agent it evicts. */
  forget: (agentId: string) => void;
  /** The id of the store's own agent, which is never evicted. */
  ownId: () => string;
}

/** The places a store can hold agents, and which origin introduced each. */
export class AgentSlots implements ClaimSlots {
  /** The agents each origin introduced and the store still holds, or has just claimed. */
  private readonly byOrigin = new Map<string, Set<string>>();

  private readonly originOf = new Map<string, string>();

  constructor(private readonly store: AgentSlotsStore) {}

  /** Starts the claims of one message from `origin`. */
  open(origin: string): AgentClaims {
    return new AgentClaims(this, origin);
  }

  /** Forgets what an origin introduced, once nothing of it is held. */
  release(origin: string): void {
    this.heldFrom(origin, new Set());
  }

  has(agentId: string): boolean {
    return this.store.agents.has(agentId);
  }

  get size(): number {
    return this.store.agents.size;
  }

  /** How many agents `origin` introduced that the store still holds, besides those in `keep`, which a message has claimed and not yet stored. */
  heldFrom(origin: string, keep: ReadonlySet<string>): number {
    const ids = this.byOrigin.get(origin);
    if (ids === undefined) return 0;
    for (const id of ids) {
      if (!this.store.agents.has(id) && !keep.has(id)) {
        ids.delete(id);
        this.originOf.delete(id);
      }
    }
    if (ids.size === 0) this.byOrigin.delete(origin);
    return ids.size;
  }

  tag(agentId: string, origin: string): void {
    this.originOf.set(agentId, origin);
    const ids = this.byOrigin.get(origin) ?? new Set<string>();
    ids.add(agentId);
    this.byOrigin.set(origin, ids);
  }

  /** Evicts the record that has been offline longest and returns whether there was one, among those `origin` introduced when it is given. Only an offline record is evictable, and never one in `keep` or the store's own. */
  evictOne(keep: ReadonlySet<string>, origin?: string): boolean {
    const ownId = this.store.ownId();
    let victim: string | undefined;
    for (const id of this.store.agents.offlineOldestFirst()) {
      if (keep.has(id) || id === ownId) continue;
      if (origin !== undefined && this.originOf.get(id) !== origin) continue;
      victim = id;
      break;
    }
    if (victim === undefined) return false;
    this.store.forget(victim);
    return true;
  }
}

function capped<T>(
  entries: Record<string, T>,
  limit: number,
): { kept: Record<string, T>; dropped: number } {
  const all = Object.entries(entries);
  if (all.length <= limit) return { kept: entries, dropped: 0 };
  return {
    kept: Object.fromEntries(all.slice(0, limit)),
    dropped: all.length - limit,
  };
}

/**
 * The part of a snapshot this side takes. An agent record is kept only when it is well formed, is described by its own store or the coordinator, and fits in the store; the receiver's own record is also kept when it says offline, since the store contradicts that and never applies it. Every collection is cut to MAX_SNAPSHOT_ENTRIES.
 */
export function admitSnapshot(
  state: Readonly<SerialisedState>,
  sender: Readonly<StateSender>,
  ownId: string,
  claims: AgentClaims,
): AdmittedSnapshot {
  let refused = 0;
  const agents: Record<string, AgentIdentity> = {};
  const awaitingAuthority: AgentIdentity[] = [];
  for (const [key, agent] of Object.entries(state.agents)) {
    const contradictable =
      key === ownId && agent.status === "offline" && claims.has(key);
    const wellFormed = isWellFormedAgent(key, agent);
    const authorised = mayDescribeAgent(sender, key) || contradictable;
    if (!wellFormed || !authorised || !claims.claim(key)) {
      refused += 1;
      if (wellFormed && !authorised) awaitingAuthority.push(agent);
      continue;
    }
    agents[key] = agent;
  }
  const cappedAgents = capped(agents, MAX_SNAPSHOT_ENTRIES);
  const rooms = capped(state.rooms, MAX_SNAPSHOT_ENTRIES);
  const messages = capped(state.messages, MAX_SNAPSHOT_ENTRIES);
  const dms = capped(state.dms, MAX_SNAPSHOT_ENTRIES);
  const queues = capped(state.deliveryQueues, MAX_SNAPSHOT_ENTRIES);
  refused +=
    cappedAgents.dropped +
    rooms.dropped +
    messages.dropped +
    dms.dropped +
    queues.dropped;
  return {
    value: {
      agents: cappedAgents.kept,
      rooms: rooms.kept,
      messages: messages.kept,
      dms: dms.kept,
      deliveryQueues: queues.kept,
    },
    refused,
    awaitingAuthority,
  };
}

/**
 * Whether a patch is taken. A patch about an agent is taken under the same rules as a snapshot's agent record, and an offline report about the receiver's own agent is always taken, since it only ever makes the store contradict it. Every other patch is taken as it is.
 */
export function admitPatch(
  patch: Readonly<MeshStatePatch>,
  sender: Readonly<StateSender>,
  ownId: string,
  claims: AgentClaims,
): boolean {
  if (patch.type === "agent_upsert") {
    const { agent } = patch;
    return (
      isWellFormedAgent(agent.id, agent) &&
      mayDescribeAgent(sender, agent.id) &&
      claims.claim(agent.id)
    );
  }
  if (patch.type === "agent_offline") {
    return patch.agentId === ownId || mayDescribeAgent(sender, patch.agentId);
  }
  return true;
}

/** Whether a patch was refused only because its sender is not known to be the coordinator, which a later claim can make it. */
export function isAwaitingAuthority(
  patch: Readonly<MeshStatePatch>,
  sender: Readonly<StateSender>,
): boolean {
  if (patch.type === "agent_upsert") {
    return (
      isWellFormedAgent(patch.agent.id, patch.agent) &&
      !mayDescribeAgent(sender, patch.agent.id)
    );
  }
  return (
    patch.type === "agent_offline" && !mayDescribeAgent(sender, patch.agentId)
  );
}

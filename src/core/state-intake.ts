/**
 * What a store takes from the state a peer sends it: a snapshot or a patch of agents, rooms, messages and the rest is checked at the wire boundary, before any of it reaches the delivery engine. A record of an agent is accepted only from the peer whose device id it names, or from the peer this side takes to be the coordinator, since an agent is its own store's peer and no other peer is the authority on it; the number of entries one snapshot may carry, and the number of agents a store keeps, are bounded. A report about the receiver's own agent is the exception: an offline report, or an offline record, is let through so the store can contradict it.
 */

import { parseDisplayName } from "./display-name.js";
import { parseIsoTimestampMs } from "./iso-timestamp.js";
import type { AgentIdentity } from "./types.js";
import type { MeshStatePatch, SerialisedState } from "./wire-protocol.js";

/**
 * The most entries one snapshot may carry in any one of its collections (agents, rooms, message histories, direct-message histories, delivery queues). A machine's mesh holds a few agents per session that is open on it, so a few thousand is far above any real one, while one snapshot cannot make a store hold an unbounded amount.
 */
export const MAX_SNAPSHOT_ENTRIES = 4096;

/** The most agents a store keeps. Past it, a new agent takes the place of an offline record, and is refused only when no record is offline; one already known is still updated. At least the largest snapshot, so a full snapshot of a full mesh fits. */
export const MAX_KNOWN_AGENTS = 4096;

/** The most agents one connection may introduce over its life. A conforming peer introduces its own agent, or as coordinator relays the mesh, so far fewer. */
export const MAX_NEW_AGENTS_PER_SOURCE = 256;

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

/** Whether `sender` may speak for the agent `agentId`: it is that agent's own store, or the coordinator. */
function mayDescribeAgent(sender: StateSender, agentId: string): boolean {
  return sender.id === agentId || sender.isCoordinator;
}

/** Whether a record is one a conforming peer sends: it sits under its own id and its name is one a registration would have kept as it is. */
function isWellFormedAgent(
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

/**
 * The order records are evicted in: a start time that does not parse, or lies in the future, first (no conforming record has one), then the oldest start. No time of going offline is recorded, so the start time stands in for it.
 */
function evictionRank(agent: Readonly<AgentIdentity>, now: number): number {
  const startedAt = parseIsoTimestampMs(agent.startedAt);
  return startedAt === undefined || startedAt > now
    ? Number.NEGATIVE_INFINITY
    : startedAt;
}

/** What a claim needs of the store's agent slots. */
interface ClaimSlots {
  has: (agentId: string) => boolean;
  size: number;
  introducedBy: (sourceId: string) => number;
  noteIntroduced: (sourceId: string) => void;
  evictOne: (keep: ReadonlySet<string>) => boolean;
}

/** The claims on agent slots that the records of one message make. */
export class AgentClaims {
  private readonly claimed = new Set<string>();

  constructor(
    private readonly slots: Readonly<ClaimSlots>,
    private readonly sourceId: string,
  ) {}

  has(agentId: string): boolean {
    return this.slots.has(agentId);
  }

  /** Whether the store takes a record for `agentId`: it already holds one, or it can hold a new one. A new one counts against the connection that introduced it, and past the store's bound takes the place of an offline record. */
  claim(agentId: string): boolean {
    if (this.slots.has(agentId) || this.claimed.has(agentId)) return true;
    if (this.slots.introducedBy(this.sourceId) >= MAX_NEW_AGENTS_PER_SOURCE) {
      return false;
    }
    if (
      this.slots.size + this.claimed.size >= MAX_KNOWN_AGENTS &&
      !this.slots.evictOne(this.claimed)
    ) {
      return false;
    }
    this.claimed.add(agentId);
    this.slots.noteIntroduced(this.sourceId);
    return true;
  }
}

/** What an AgentSlots reads of, and does to, the store. */
export interface AgentSlotsStore {
  readonly agents: ReadonlyMap<string, AgentIdentity>;
  /** Forgets everything the store holds for an agent it evicts. */
  forget: (agentId: string) => void;
  /** Whether the store still has a peer entry for the agent: an offline record without one is evicted before one with one. */
  hasPeer: (agentId: string) => boolean;
  /** The id of the store's own agent, which is never evicted. */
  ownId: () => string;
  /** The current time, in milliseconds since the epoch. */
  now: () => number;
}

/** The places a store can hold agents, and how many new ones each connection has introduced. */
export class AgentSlots implements ClaimSlots {
  private readonly introduced = new Map<string, number>();

  constructor(private readonly store: AgentSlotsStore) {}

  /** Starts the claims of one message from `sourceId`. */
  open(sourceId: string): AgentClaims {
    return new AgentClaims(this, sourceId);
  }

  /** Forgets what a connection introduced, once it has ended. */
  release(sourceId: string): void {
    this.introduced.delete(sourceId);
  }

  has(agentId: string): boolean {
    return this.store.agents.has(agentId);
  }

  get size(): number {
    return this.store.agents.size;
  }

  introducedBy(sourceId: string): number {
    return this.introduced.get(sourceId) ?? 0;
  }

  noteIntroduced(sourceId: string): void {
    this.introduced.set(sourceId, this.introducedBy(sourceId) + 1);
  }

  /** Evicts the record that is least worth keeping and returns whether there was one. Only an offline record is evictable, and never one in `keep` or the store's own. */
  evictOne(keep: ReadonlySet<string>): boolean {
    const now = this.store.now();
    let victim: { id: string; unconnected: boolean; rank: number } | undefined;
    for (const [id, agent] of this.store.agents) {
      if (
        agent.status !== "offline" ||
        keep.has(id) ||
        id === this.store.ownId()
      ) {
        continue;
      }
      const candidate = {
        id,
        unconnected: !this.store.hasPeer(id),
        rank: evictionRank(agent, now),
      };
      if (
        victim === undefined ||
        (candidate.unconnected && !victim.unconnected) ||
        (candidate.unconnected === victim.unconnected &&
          candidate.rank < victim.rank)
      ) {
        victim = candidate;
      }
    }
    if (victim === undefined) return false;
    this.store.forget(victim.id);
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
): Admitted<SerialisedState> {
  let refused = 0;
  const agents: Record<string, AgentIdentity> = {};
  for (const [key, agent] of Object.entries(state.agents)) {
    const contradictable =
      key === ownId && agent.status === "offline" && claims.has(key);
    if (
      !isWellFormedAgent(key, agent) ||
      !(mayDescribeAgent(sender, key) || contradictable) ||
      !claims.claim(key)
    ) {
      refused += 1;
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

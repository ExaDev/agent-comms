/**
 * What a store takes from the state a peer sends it: a snapshot or a patch of agents, rooms, messages and the rest is checked at the wire boundary, before any of it reaches the delivery engine. A record of an agent is accepted only from the peer whose device id it names, or from the peer this side takes to be the coordinator, since an agent is its own store's peer and no other peer is the authority on it; the number of entries one snapshot may carry, and the number of agents a store keeps, are bounded. A store that sends its own state, which is every store, is unaffected.
 */

import { parseDisplayName } from "./display-name.js";
import type { AgentIdentity } from "./types.js";
import type { MeshStatePatch, SerialisedState } from "./wire-protocol.js";

/**
 * The most entries one snapshot may carry in any one of its collections (agents, rooms, message histories, direct-message histories, delivery queues). A machine's mesh holds a few agents per session that is open on it, so a few thousand is far above any real one, while one snapshot cannot make a store hold an unbounded amount.
 */
export const MAX_SNAPSHOT_ENTRIES = 4096;

/** The most agents a store keeps. A new agent beyond it is refused; one already known is still updated. At least the largest snapshot, so a full snapshot of a full mesh fits. */
export const MAX_KNOWN_AGENTS = 4096;

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
 * The part of a snapshot this side takes. Agent records are kept only when they are well formed, are described by their own store or the coordinator, and would not take the store past MAX_KNOWN_AGENTS; every collection is cut to MAX_SNAPSHOT_ENTRIES.
 */
export function admitSnapshot(
  state: Readonly<SerialisedState>,
  sender: Readonly<StateSender>,
  known: ReadonlyMap<string, unknown>,
): Admitted<SerialisedState> {
  let refused = 0;
  const agents: Record<string, AgentIdentity> = {};
  let room = MAX_KNOWN_AGENTS - known.size;
  for (const [key, agent] of Object.entries(state.agents)) {
    const fresh = !known.has(key);
    if (
      !isWellFormedAgent(key, agent) ||
      !mayDescribeAgent(sender, key) ||
      (fresh && room <= 0)
    ) {
      refused += 1;
      continue;
    }
    if (fresh) room -= 1;
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
 * Whether a patch is taken. A patch about an agent is taken under the same rules as a snapshot's agent record; every other patch is taken as it is.
 */
export function admitPatch(
  patch: Readonly<MeshStatePatch>,
  sender: Readonly<StateSender>,
  known: ReadonlyMap<string, unknown>,
): boolean {
  if (patch.type === "agent_upsert") {
    const { agent } = patch;
    if (!isWellFormedAgent(agent.id, agent)) return false;
    if (!mayDescribeAgent(sender, agent.id)) return false;
    return known.has(agent.id) || known.size < MAX_KNOWN_AGENTS;
  }
  if (patch.type === "agent_offline") {
    return mayDescribeAgent(sender, patch.agentId);
  }
  return true;
}

/**
 * State a peer sent before this side had accepted the claim that makes the peer the coordinator. The coordinator's own snapshot and announcements can be read ahead of the claim that names it, since they arrive on a different queue of the same session, so what is refused only for want of that authority is held and taken once a claim naming the sender is accepted. What is held is bounded, expires after one claim wait, and is dropped when a claim naming another peer is accepted, since the sender then is not the coordinator; a held departure is applied only if the agent's record is as it was when the report was held, so a report about an agent that has since come back is not applied.
 */

import type { AgentIdentity } from "./types.js";

/** The most peers whose state is held at once. */
export const MAX_HELD_SENDERS = 16;

/** The most agent records held for one sender: the most one snapshot may carry that a store would keep, a few hundred at a time being what a coordinator relays. */
export const MAX_HELD_AGENTS_PER_SENDER = 256;

/** The most departures held for one sender. */
export const MAX_HELD_DEPARTURES_PER_SENDER = 64;

interface Held {
  readonly heldAt: number;
  readonly agents: Map<string, AgentIdentity>;
  /** Each held departure, with the version of the agent's record when it was held (undefined when there was none). */
  readonly departures: Map<string, number | undefined>;
}

/** What a claim naming a sender released. */
export interface Released {
  readonly agents: readonly AgentIdentity[];
  readonly departures: readonly string[];
}

export class DeferredIntake {
  private readonly bySender = new Map<string, Held>();

  /**
   * @param now - The current time in milliseconds.
   * @param ttlMs - How long a sender's held state stays valid, counted from the first thing held for it.
   * @param versionOf - The version of the record this store holds for an agent, if any.
   */
  constructor(
    private readonly now: () => number,
    private readonly ttlMs: number,
    private readonly versionOf: (agentId: string) => number | undefined,
  ) {}

  private heldFor(senderId: string): Held | undefined {
    const now = this.now();
    const existing = this.bySender.get(senderId);
    if (existing !== undefined && now - existing.heldAt <= this.ttlMs) {
      return existing;
    }
    this.bySender.delete(senderId);
    for (const [id, held] of this.bySender) {
      if (now - held.heldAt > this.ttlMs) this.bySender.delete(id);
    }
    if (this.bySender.size >= MAX_HELD_SENDERS) return undefined;
    const created: Held = {
      heldAt: now,
      agents: new Map(),
      departures: new Map(),
    };
    this.bySender.set(senderId, created);
    return created;
  }

  holdAgent(senderId: string, agent: Readonly<AgentIdentity>): void {
    const held = this.heldFor(senderId);
    if (held === undefined) return;
    if (
      held.agents.size >= MAX_HELD_AGENTS_PER_SENDER &&
      !held.agents.has(agent.id)
    ) {
      return;
    }
    held.agents.set(agent.id, { ...agent });
  }

  holdDeparture(senderId: string, agentId: string): void {
    const held = this.heldFor(senderId);
    if (held === undefined) return;
    if (
      held.departures.size >= MAX_HELD_DEPARTURES_PER_SENDER &&
      !held.departures.has(agentId)
    ) {
      return;
    }
    held.departures.set(agentId, this.versionOf(agentId));
  }

  /** What a claim naming `holderId` releases: its held state if still valid. Everything held for any other sender is dropped, since a claim naming someone else was accepted. */
  release(holderId: string): Released {
    const held = this.bySender.get(holderId);
    const expired = held !== undefined && this.now() - held.heldAt > this.ttlMs;
    this.bySender.clear();
    if (held === undefined || expired) return { agents: [], departures: [] };
    return {
      agents: [...held.agents.values()],
      departures: [...held.departures]
        .filter(([agentId, version]) => this.versionOf(agentId) === version)
        .map(([agentId]) => agentId),
    };
  }

  /** Drops what is held for a sender whose connection ended. */
  drop(senderId: string): void {
    this.bySender.delete(senderId);
  }
}

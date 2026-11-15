/**
 * The agents a store knows of, with the order in which their records went offline, so that a store at its bound can give up the record that has been offline longest. The order is the one in which this store first saw each record offline, kept while it stays offline and dropped when it comes back or is removed; it is local to the store and never sent.
 */

import type { AgentIdentity } from "./types.js";

export class KnownAgents extends Map<string, AgentIdentity> {
  /** The offline records in the order they went offline: an id is added when its record is first seen offline and keeps its place while it stays, so the first is the one offline longest. */
  private readonly offlineOrder = new Set<string>();

  override set(agentId: string, agent: AgentIdentity): this {
    super.set(agentId, agent);
    if (agent.status === "offline") {
      this.offlineOrder.add(agentId);
    } else {
      this.offlineOrder.delete(agentId);
    }
    return this;
  }

  override delete(agentId: string): boolean {
    this.offlineOrder.delete(agentId);
    return super.delete(agentId);
  }

  override clear(): void {
    this.offlineOrder.clear();
    super.clear();
  }

  /** The ids of the offline records, the one that went offline longest ago first. */
  offlineOldestFirst(): IterableIterator<string> {
    return this.offlineOrder.values();
  }
}

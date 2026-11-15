/**
 * The agents a store knows of, with the order in which their records went offline, so that a store at its bound can give up the record that has been offline longest. The order follows a record's status only through `set`, so a caller that changes a stored record's status in place must store it again; it is the order in which this store first saw each record offline, kept while it stays offline and dropped when it comes back or is removed, local to the store and never sent.
 */

import type { AgentIdentity } from "./types.js";

export class KnownAgents extends Map<string, AgentIdentity> {
  /** The offline records in the order they went offline: an id is added when its record is first seen offline and keeps its place while it stays, so the first is the one offline longest. */
  private readonly offlineOrder = new Set<string>();

  private readonly deletionListeners: ((agentId: string) => void)[] = [];

  /** Calls `listener` with the id of every record that is removed, by `delete` or `clear`. */
  onDeleted(listener: (agentId: string) => void): void {
    this.deletionListeners.push(listener);
  }

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
    const removed = super.delete(agentId);
    if (removed) this.notifyDeleted(agentId);
    return removed;
  }

  override clear(): void {
    const ids = [...this.keys()];
    this.offlineOrder.clear();
    super.clear();
    for (const id of ids) this.notifyDeleted(id);
  }

  private notifyDeleted(agentId: string): void {
    for (const listener of this.deletionListeners) listener(agentId);
  }

  /** The ids of the offline records, the one that went offline longest ago first. */
  offlineOldestFirst(): IterableIterator<string> {
    return this.offlineOrder.values();
  }
}

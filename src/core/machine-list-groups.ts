/**
 * list_agents' machine grouping (agent-comms#343): the listed agents split into one group per machine, this host first, then every other machine by id, then the agents no machine proof places. Split out of tool.ts to keep that file under the repo's max-lines cap.
 */

import type { AgentIdentity } from "./types.js";

/** One run of listed agents and the heading above it; no heading when nothing is grouped at all. */
export interface AgentGroup {
  heading: string | undefined;
  agents: AgentIdentity[];
}

/** agents grouped by machine, each group keeping the agents' listed order. machines maps device id to machine id (MeshStore.listAgentMachines); undefined on a store with no machine identity, in which case, as when no agent is placed on a machine, the list is one ungrouped run. */
export function groupAgentsByMachine(
  agents: readonly AgentIdentity[],
  machines: ReadonlyMap<string, string> | undefined,
  ownMachine: string | undefined,
): AgentGroup[] {
  if (
    machines === undefined ||
    !agents.some((agent) => machines.has(agent.id))
  ) {
    return [{ heading: undefined, agents: [...agents] }];
  }
  const byMachine = new Map<string, AgentIdentity[]>();
  const unplaced: AgentIdentity[] = [];
  for (const agent of agents) {
    const machine = machines.get(agent.id);
    if (machine === undefined) {
      unplaced.push(agent);
      continue;
    }
    const group = byMachine.get(machine);
    if (group === undefined) byMachine.set(machine, [agent]);
    else group.push(agent);
  }
  const groups: AgentGroup[] = [...byMachine]
    .sort(([a], [b]) => {
      if (a === ownMachine) return -1;
      if (b === ownMachine) return 1;
      return a.localeCompare(b);
    })
    .map(([machine, members]) => ({
      heading: `Machine ${machine}${machine === ownMachine ? " (this machine)" : ""}:`,
      agents: members,
    }));
  if (unplaced.length > 0) {
    groups.push({ heading: "Machine not proven:", agents: unplaced });
  }
  return groups;
}

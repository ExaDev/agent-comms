/**
 * Unit tests for list_agents' machine grouping (agent-comms#343): this host first, other machines by id, unplaced agents last, and no grouping at all when nothing is placed.
 */

import { describe, expect, it } from "vitest";
import { groupAgentsByMachine } from "../core/machine-list-groups.js";
import type { AgentIdentity } from "../core/types.js";

function agent(id: string): AgentIdentity {
  return {
    id,
    version: 0,
    name: id,
    harness: "test",
    cwd: "/test",
    pid: 1,
    startedAt: "",
    visibility: "visible",
    status: "active",
    tags: [],
    subscribedRooms: [],
  };
}

describe("groupAgentsByMachine", () => {
  it("puts this machine first, then other machines by id, then agents no proof places", () => {
    const agents = ["remote-b", "local", "unplaced", "remote-a"].map(agent);
    const machines = new Map([
      ["remote-b", "bbbb"],
      ["local", "mine"],
      ["remote-a", "aaaa"],
    ]);

    const groups = groupAgentsByMachine(agents, machines, "mine");

    expect(
      groups.map((group) => [group.heading, group.agents.map((a) => a.id)]),
    ).toEqual([
      ["Machine mine (this machine):", ["local"]],
      ["Machine aaaa:", ["remote-a"]],
      ["Machine bbbb:", ["remote-b"]],
      ["Machine not proven:", ["unplaced"]],
    ]);
  });

  it("keeps several agents of one machine together in their listed order", () => {
    const agents = ["one", "other", "two"].map(agent);
    const machines = new Map([
      ["one", "mine"],
      ["other", "theirs"],
      ["two", "mine"],
    ]);

    const groups = groupAgentsByMachine(agents, machines, "mine");

    expect(groups[0]?.agents.map((a) => a.id)).toEqual(["one", "two"]);
  });

  it("lists everything as one ungrouped run when no agent is placed on a machine, or the store has no machine identity", () => {
    const agents = ["a", "b"].map(agent);

    expect(groupAgentsByMachine(agents, new Map(), "mine")).toEqual([
      { heading: undefined, agents },
    ]);
    expect(groupAgentsByMachine(agents, undefined, undefined)).toEqual([
      { heading: undefined, agents },
    ]);
  });
});

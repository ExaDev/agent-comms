import { describe, expect, it } from "vitest";
import {
  buildSelfAgentAdvert,
  buildSelfAgentCard,
} from "../core/agent-adverts.js";
import type { AgentIdentity } from "../core/types.js";

function agent(overrides: Partial<AgentIdentity> = {}): AgentIdentity {
  return {
    id: "agent-1",
    version: 1,
    name: "worker",
    harness: "pi",
    cwd: "/home/someone/project",
    pid: 1234,
    startedAt: "2026-05-05T00:00:00.000Z",
    visibility: "visible",
    status: "active",
    tags: ["ci"],
    subscribedRooms: ["room-a"],
    ...overrides,
  };
}

describe("buildSelfAgentCard", () => {
  it("carries who the agent is and nothing about where it runs", () => {
    expect(buildSelfAgentCard(agent(), {})).toEqual({
      name: "worker",
      harness: "pi",
      startedAt: "2026-05-05T00:00:00.000Z",
      tags: ["ci"],
    });
  });

  it("adds the membership proof when there is one", () => {
    expect(buildSelfAgentCard(agent(), { membership: "proof" })).toMatchObject({
      membership: "proof",
    });
  });

  it.each(["hidden", "ghost"] as const)(
    "is nothing for a %s agent",
    (visibility) => {
      expect(buildSelfAgentCard(agent({ visibility }), {})).toBeUndefined();
    },
  );

  it("is nothing when there is no agent", () => {
    expect(buildSelfAgentCard(undefined, {})).toBeUndefined();
  });
});

describe("buildSelfAgentAdvert", () => {
  it("still carries where the agent runs, for peers on a private link", () => {
    expect(buildSelfAgentAdvert(agent(), {})).toMatchObject({
      cwd: "/home/someone/project",
      pid: 1234,
      subscribedRooms: ["room-a"],
    });
  });

  it.each(["hidden", "ghost"] as const)(
    "is nothing for a %s agent",
    (visibility) => {
      expect(buildSelfAgentAdvert(agent({ visibility }), {})).toBeUndefined();
    },
  );
});

/**
 * Unit tests for buildProjectTree.
 */

import { describe, it, expect } from "vitest";
import { buildProjectTree } from "../project-tree.js";
import type { Agent, Room } from "../types.js";

function makeAgent(overrides: Partial<Agent> & { id: string }): Agent {
  return {
    id: overrides.id,
    name: overrides.name ?? `agent-${overrides.id}`,
    harness: "pi",
    cwd: overrides.cwd ?? `/home/user/project-${overrides.id}`,
    pid: 1,
    startedAt: "",
    visibility: "visible",
    status: "active",
    tags: [],
    subscribedRooms: [],
  };
}

const EXPECTED_DIRECTORY_AND_AGENT_CHILD_COUNT = 4;

function makeRoom(overrides: Partial<Room> & { id: string }): Room {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    type: "public",
    owner: "a1",
    createdAt: "",
    description: overrides.description ?? "",
    members: [],
    invited: [],
  };
}

describe("buildProjectTree", () => {
  it("returns empty tree for no agents and no rooms", () => {
    const result = buildProjectTree([], []);
    expect(result.roots).toEqual([]);
    expect(result.manualRooms).toEqual([]);
  });

  it("shows directories from project rooms even with no agents", () => {
    const rooms = [
      makeRoom({
        id: "my-app",
        name: "my-app",
        description: "Project room for /home/user/dev/my-app",
      }),
    ];
    const result = buildProjectTree([], rooms);
    expect(result.roots.length).toBe(1);
    const dir = result.roots[0];
    expect(dir?.type).toBe("directory");
    if (dir?.type !== "directory") return;
    expect(dir.name).toBe("my-app");
    expect(dir.roomId).toBe("my-app");
  });

  it("returns empty roots when no agents but has manual rooms", () => {
    const rooms = [makeRoom({ id: "general", description: "General chat" })];
    const result = buildProjectTree([], rooms);
    expect(result.roots).toEqual([]);
    expect(result.manualRooms.length).toBe(1);
    expect(result.manualRooms[0]?.id).toBe("general");
  });

  it("places a single agent under its directory basename", () => {
    const agents = [
      makeAgent({ id: "a1", cwd: "/Users/joe/Developer/my-app" }),
    ];
    const result = buildProjectTree(agents, []);
    expect(result.roots.length).toBe(1);

    const dir = result.roots[0];
    expect(dir?.type, "root should be a directory").toBe("directory");
    if (dir?.type !== "directory") return;
    expect(dir.name).toBe("my-app");
    expect(dir.children.length).toBe(1);

    const agentNode = dir.children[0];
    expect(agentNode?.type).toBe("agent");
    if (agentNode?.type !== "agent") return;
    expect(agentNode.agentId).toBe("a1");
  });

  it("groups agents in the same directory as siblings", () => {
    const agents = [
      makeAgent({ id: "a1", cwd: "/Users/joe/Developer/my-app" }),
      makeAgent({ id: "a2", cwd: "/Users/joe/Developer/my-app" }),
    ];
    const result = buildProjectTree(agents, []);

    expect(result.roots.length).toBe(1);
    const dir = result.roots[0];
    expect(dir?.type).toBe("directory");
    if (dir?.type !== "directory") return;
    expect(dir.children.length).toBe(2);
    expect(dir.children[0]?.type).toBe("agent");
    expect(dir.children[1]?.type).toBe("agent");
  });

  it("creates nested directories for agents at different depths", () => {
    const agents = [
      makeAgent({ id: "a1", cwd: "/Users/joe/Developer" }),
      makeAgent({ id: "a2", cwd: "/Users/joe/Developer/my-app" }),
    ];
    const result = buildProjectTree(agents, []);

    // Common prefix is /Users/joe, trimmed
    // Remaining: "Developer" → "Developer/my-app"
    expect(result.roots.length).toBe(1);

    const dev = result.roots[0];
    expect(dev?.type).toBe("directory");
    if (dev?.type !== "directory") return;
    expect(dev.name).toBe("Developer");

    // Should have agent a1 (in Developer) and directory my-app (with a2)
    expect(dev.children.length).toBe(2);

    const dirChild = dev.children.find((c) => c.type === "directory");
    const agentChild = dev.children.find((c) => c.type === "agent");

    expect(dirChild, "should have a directory child").toBeTruthy();
    expect(agentChild, "should have an agent child").toBeTruthy();

    if (dirChild?.type !== "directory") return;
    expect(dirChild.name).toBe("my-app");
    expect(dirChild.children.length).toBe(1);

    if (agentChild?.type !== "agent") return;
    expect(agentChild.agentId).toBe("a1");
  });

  it("sorts directories before agents, both alphabetically", () => {
    const agents = [
      makeAgent({
        id: "z-agent",
        name: "z-agent",
        cwd: "/Users/joe/Developer",
      }),
      makeAgent({
        id: "a-agent",
        name: "a-agent",
        cwd: "/Users/joe/Developer",
      }),
      makeAgent({ id: "a3", cwd: "/Users/joe/Developer/z-project" }),
      makeAgent({ id: "a4", cwd: "/Users/joe/Developer/a-project" }),
    ];
    const result = buildProjectTree(agents, []);

    const dev = result.roots[0];
    expect(dev?.type).toBe("directory");
    if (dev?.type !== "directory") return;

    // 2 directories + 2 agents
    expect(dev.children.length).toBe(EXPECTED_DIRECTORY_AND_AGENT_CHILD_COUNT);

    // First two should be directories, sorted alphabetically
    expect(dev.children[0]?.type).toBe("directory");
    expect(dev.children[0]?.name).toBe("a-project");
    expect(dev.children[1]?.type).toBe("directory");
    expect(dev.children[1]?.name).toBe("z-project");

    // Next two should be agents, sorted alphabetically
    expect(dev.children[2]?.type).toBe("agent");
    expect(dev.children[2]?.name).toBe("a-agent");
    expect(dev.children[3]?.type).toBe("agent");
    expect(dev.children[3]?.name).toBe("z-agent");
  });

  it("separates manual rooms from project rooms", () => {
    const agents = [makeAgent({ id: "a1", cwd: "/home/user/app" })];
    const rooms = [
      makeRoom({ id: "general", description: "General chat" }),
      makeRoom({
        id: "app",
        description: "Project room for /home/user/app",
      }),
    ];

    const result = buildProjectTree(agents, rooms);
    expect(result.manualRooms.length).toBe(1);
    expect(result.manualRooms[0]?.id).toBe("general");
  });

  it("attaches roomId to directory nodes with project rooms", () => {
    const agents = [makeAgent({ id: "a1", cwd: "/home/user/dev/my-app" })];
    const rooms = [
      makeRoom({
        id: "my-app",
        name: "my-app",
        description: "Project room for /home/user/dev/my-app",
      }),
    ];
    const result = buildProjectTree(agents, rooms);

    const dir = result.roots[0];
    expect(dir?.type).toBe("directory");
    if (dir?.type !== "directory") return;
    expect(dir.roomId).toBe("my-app");
  });

  it("does not attach roomId when no project room matches", () => {
    const agents = [makeAgent({ id: "a1", cwd: "/home/user/dev/my-app" })];
    const result = buildProjectTree(agents, []);

    const dir = result.roots[0];
    expect(dir?.type).toBe("directory");
    if (dir?.type !== "directory") return;
    expect(dir.roomId).toBe(undefined);
  });

  it("handles agents with no common prefix", () => {
    const agents = [
      makeAgent({ id: "a1", cwd: "/Users/alice/project" }),
      makeAgent({ id: "a2", cwd: "/Users/bob/project" }),
    ];
    const result = buildProjectTree(agents, []);

    // Common segment: "Users" → parent trim → root "/"
    // Full tree: Users > alice > project > agent, Users > bob > project > agent
    expect(result.roots.length).toBe(1);

    const users = result.roots[0];
    expect(users?.type).toBe("directory");
    if (users?.type !== "directory") return;
    expect(users.name).toBe("Users");
    expect(users.children.length).toBe(2);

    const alice = users.children[0];
    const bob = users.children[1];
    expect(alice?.type).toBe("directory");
    expect(bob?.type).toBe("directory");
    expect(alice.name).toBe("alice");
    expect(bob.name).toBe("bob");
  });

  it("trims common prefix shared by all agents", () => {
    const agents = [
      makeAgent({ id: "a1", cwd: "/Users/joe/Developer/app1" }),
      makeAgent({ id: "a2", cwd: "/Users/joe/Developer/app2" }),
    ];
    const result = buildProjectTree(agents, []);

    // Common path: /Users/joe/Developer → parent trim → /Users/joe
    // Remaining: Developer/app1 and Developer/app2
    expect(result.roots.length).toBe(1);

    const dev = result.roots[0];
    expect(dev?.type).toBe("directory");
    if (dev?.type !== "directory") return;
    expect(dev.name).toBe("Developer");
    expect(dev.children.length).toBe(2);
    expect(dev.children[0]?.name).toBe("app1");
    expect(dev.children[1]?.name).toBe("app2");
  });

  it("handles deeply nested paths", () => {
    const agents = [makeAgent({ id: "a1", cwd: "/a/b/c/d" })];
    const result = buildProjectTree(agents, []);

    // Single agent: prefix trimmed to /a/b/c, tree starts at "d"
    expect(result.roots.length).toBe(1);

    const d = result.roots[0];
    expect(d?.type).toBe("directory");
    if (d?.type !== "directory") return;
    expect(d.name).toBe("d");
    expect(d.children.length).toBe(1);
    expect(d.children[0]?.type).toBe("agent");
    if (d.children[0]?.type !== "agent") return;
    expect(d.children[0].agentId).toBe("a1");
  });
});

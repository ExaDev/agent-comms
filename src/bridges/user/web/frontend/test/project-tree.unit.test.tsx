/**
 * Unit tests for buildProjectTree.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
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
    assert.deepStrictEqual(result.roots, []);
    assert.deepStrictEqual(result.manualRooms, []);
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
    assert.strictEqual(result.roots.length, 1);
    const dir = result.roots[0];
    assert.ok(dir?.type === "directory");
    if (dir?.type !== "directory") return;
    assert.strictEqual(dir.name, "my-app");
    assert.strictEqual(dir.roomId, "my-app");
  });

  it("returns empty roots when no agents but has manual rooms", () => {
    const rooms = [makeRoom({ id: "general", description: "General chat" })];
    const result = buildProjectTree([], rooms);
    assert.deepStrictEqual(result.roots, []);
    assert.strictEqual(result.manualRooms.length, 1);
    assert.strictEqual(result.manualRooms[0]?.id, "general");
  });

  it("places a single agent under its directory basename", () => {
    const agents = [
      makeAgent({ id: "a1", cwd: "/Users/joe/Developer/my-app" }),
    ];
    const result = buildProjectTree(agents, []);
    assert.strictEqual(result.roots.length, 1);

    const dir = result.roots[0];
    assert.ok(dir?.type === "directory", "root should be a directory");
    if (dir?.type !== "directory") return;
    assert.strictEqual(dir.name, "my-app");
    assert.strictEqual(dir.children.length, 1);

    const agentNode = dir.children[0];
    assert.ok(agentNode?.type === "agent");
    if (agentNode?.type !== "agent") return;
    assert.strictEqual(agentNode.agentId, "a1");
  });

  it("groups agents in the same directory as siblings", () => {
    const agents = [
      makeAgent({ id: "a1", cwd: "/Users/joe/Developer/my-app" }),
      makeAgent({ id: "a2", cwd: "/Users/joe/Developer/my-app" }),
    ];
    const result = buildProjectTree(agents, []);

    assert.strictEqual(result.roots.length, 1);
    const dir = result.roots[0];
    assert.ok(dir?.type === "directory");
    if (dir?.type !== "directory") return;
    assert.strictEqual(dir.children.length, 2);
    assert.ok(dir.children[0]?.type === "agent");
    assert.ok(dir.children[1]?.type === "agent");
  });

  it("creates nested directories for agents at different depths", () => {
    const agents = [
      makeAgent({ id: "a1", cwd: "/Users/joe/Developer" }),
      makeAgent({ id: "a2", cwd: "/Users/joe/Developer/my-app" }),
    ];
    const result = buildProjectTree(agents, []);

    // Common prefix is /Users/joe, trimmed
    // Remaining: "Developer" → "Developer/my-app"
    assert.strictEqual(result.roots.length, 1);

    const dev = result.roots[0];
    assert.ok(dev?.type === "directory");
    if (dev?.type !== "directory") return;
    assert.strictEqual(dev.name, "Developer");

    // Should have agent a1 (in Developer) and directory my-app (with a2)
    assert.strictEqual(dev.children.length, 2);

    const dirChild = dev.children.find((c) => c.type === "directory");
    const agentChild = dev.children.find((c) => c.type === "agent");

    assert.ok(dirChild, "should have a directory child");
    assert.ok(agentChild, "should have an agent child");

    if (dirChild?.type !== "directory") return;
    assert.strictEqual(dirChild.name, "my-app");
    assert.strictEqual(dirChild.children.length, 1);

    if (agentChild?.type !== "agent") return;
    assert.strictEqual(agentChild.agentId, "a1");
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
    assert.ok(dev?.type === "directory");
    if (dev?.type !== "directory") return;

    // 2 directories + 2 agents = 4 children
    assert.strictEqual(dev.children.length, 4);

    // First two should be directories, sorted alphabetically
    assert.strictEqual(dev.children[0]?.type, "directory");
    assert.strictEqual(dev.children[0]?.name, "a-project");
    assert.strictEqual(dev.children[1]?.type, "directory");
    assert.strictEqual(dev.children[1]?.name, "z-project");

    // Next two should be agents, sorted alphabetically
    assert.strictEqual(dev.children[2]?.type, "agent");
    assert.strictEqual(dev.children[2]?.name, "a-agent");
    assert.strictEqual(dev.children[3]?.type, "agent");
    assert.strictEqual(dev.children[3]?.name, "z-agent");
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
    assert.strictEqual(result.manualRooms.length, 1);
    assert.strictEqual(result.manualRooms[0]?.id, "general");
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
    assert.ok(dir?.type === "directory");
    if (dir?.type !== "directory") return;
    assert.strictEqual(dir.roomId, "my-app");
  });

  it("does not attach roomId when no project room matches", () => {
    const agents = [makeAgent({ id: "a1", cwd: "/home/user/dev/my-app" })];
    const result = buildProjectTree(agents, []);

    const dir = result.roots[0];
    assert.ok(dir?.type === "directory");
    if (dir?.type !== "directory") return;
    assert.strictEqual(dir.roomId, undefined);
  });

  it("handles agents with no common prefix", () => {
    const agents = [
      makeAgent({ id: "a1", cwd: "/Users/alice/project" }),
      makeAgent({ id: "a2", cwd: "/Users/bob/project" }),
    ];
    const result = buildProjectTree(agents, []);

    // Common segment: "Users" → parent trim → root "/"
    // Full tree: Users > alice > project > agent, Users > bob > project > agent
    assert.strictEqual(result.roots.length, 1);

    const users = result.roots[0];
    assert.ok(users?.type === "directory");
    if (users?.type !== "directory") return;
    assert.strictEqual(users.name, "Users");
    assert.strictEqual(users.children.length, 2);

    const alice = users.children[0];
    const bob = users.children[1];
    assert.ok(alice?.type === "directory");
    assert.ok(bob?.type === "directory");
    assert.strictEqual(alice.name, "alice");
    assert.strictEqual(bob.name, "bob");
  });

  it("trims common prefix shared by all agents", () => {
    const agents = [
      makeAgent({ id: "a1", cwd: "/Users/joe/Developer/app1" }),
      makeAgent({ id: "a2", cwd: "/Users/joe/Developer/app2" }),
    ];
    const result = buildProjectTree(agents, []);

    // Common path: /Users/joe/Developer → parent trim → /Users/joe
    // Remaining: Developer/app1 and Developer/app2
    assert.strictEqual(result.roots.length, 1);

    const dev = result.roots[0];
    assert.ok(dev?.type === "directory");
    if (dev?.type !== "directory") return;
    assert.strictEqual(dev.name, "Developer");
    assert.strictEqual(dev.children.length, 2);
    assert.strictEqual(dev.children[0]?.name, "app1");
    assert.strictEqual(dev.children[1]?.name, "app2");
  });

  it("handles deeply nested paths", () => {
    const agents = [makeAgent({ id: "a1", cwd: "/a/b/c/d" })];
    const result = buildProjectTree(agents, []);

    // Single agent: prefix trimmed to /a/b/c, tree starts at "d"
    assert.strictEqual(result.roots.length, 1);

    const d = result.roots[0];
    assert.ok(d?.type === "directory");
    if (d?.type !== "directory") return;
    assert.strictEqual(d.name, "d");
    assert.strictEqual(d.children.length, 1);
    assert.strictEqual(d.children[0]?.type, "agent");
    if (d.children[0]?.type !== "agent") return;
    assert.strictEqual(d.children[0].agentId, "a1");
  });
});

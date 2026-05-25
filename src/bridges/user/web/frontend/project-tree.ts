/**
 * Project tree — builds a nested directory tree from agent working directories.
 *
 * Pure function: agents + rooms → ProjectTree. No side effects.
 * Project rooms (auto-created per cwd) are embedded in their directory nodes.
 */

import type { Agent, ProjectTree, Room, TreeNode } from "./types.js";

// ---------------------------------------------------------------------------
// buildProjectTree
// ---------------------------------------------------------------------------

interface Branch {
  children: Map<string, Branch>;
  agents: Agent[];
}

function insertIntoTrie(node: Branch, segments: string[], agent: Agent): void {
  const [seg, ...rest] = segments;
  if (seg === undefined) {
    node.agents.push(agent);
    return;
  }
  let target = node.children.get(seg);
  if (!target) {
    target = { children: new Map(), agents: [] };
    node.children.set(seg, target);
  }
  insertIntoTrie(target, rest, agent);
}

/** Ensure a branch path exists in the trie (creates intermediate nodes). */
function ensureBranch(node: Branch, segments: string[]): void {
  const [seg, ...rest] = segments;
  if (seg === undefined) return;
  let child = node.children.get(seg);
  if (!child) {
    child = { children: new Map(), agents: [] };
    node.children.set(seg, child);
  }
  ensureBranch(child, rest);
}

/**
 * Build a nested project tree from agent cwd paths.
 *
 * - Trims the longest common prefix shared by ALL agent paths.
 * - Agents in parent directories appear alongside child directories.
 * - Empty branches are pruned.
 * - Manual rooms (not auto-created per cwd) are separated out.
 * - Children sorted: directories first (alphabetical), then agents (alphabetical).
 */
const PROJECT_ROOM_PREFIX = "Project room for ";

/** Check if a room is an auto-created project room. */
function isProjectRoom(room: Room): boolean {
  return room.description.startsWith(PROJECT_ROOM_PREFIX);
}

/** Extract the cwd path from a project room's description. */
function projectRoomCwd(room: Room): string {
  return room.description.slice(PROJECT_ROOM_PREFIX.length);
}

export function buildProjectTree(agents: Agent[], rooms: Room[]): ProjectTree {
  const manualRooms = rooms.filter((r) => !isProjectRoom(r));

  // Index project rooms by their cwd path
  const projectRoomsByPath = new Map<string, Room>();
  for (const room of rooms) {
    if (isProjectRoom(room)) {
      projectRoomsByPath.set(projectRoomCwd(room), room);
    }
  }

  // Use all project rooms as tree nodes even if no agents are in that directory
  const allPaths = new Set<string>();
  for (const agent of agents) {
    allPaths.add(agent.cwd);
  }
  for (const cwd of projectRoomsByPath.keys()) {
    allPaths.add(cwd);
  }

  if (allPaths.size === 0) {
    return { roots: [], manualRooms };
  }

  const paths = Array.from(allPaths);
  const prefix = commonPathPrefix(paths);
  const prefixSegments = prefix === "/" ? [] : splitPath(prefix);

  // Group agents by their trimmed path
  const root: Branch = { children: new Map(), agents: [] };

  for (const agent of agents) {
    const segments = splitPath(agent.cwd).slice(prefixSegments.length);
    insertIntoTrie(root, segments, agent);
  }

  // Ensure directory branches exist for project room paths that have no agents
  for (const cwd of projectRoomsByPath.keys()) {
    const segments = splitPath(cwd).slice(prefixSegments.length);
    ensureBranch(root, segments);
  }

  // Convert branch tree to TreeNode tree, embedding project rooms
  const roots = branchToNodesWithRooms(root, prefix, "", projectRoomsByPath);

  return { roots: sortChildren(roots), manualRooms };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function splitPath(p: string): string[] {
  // "/Users/joe/Developer" → ["Users", "joe", "Developer"]
  return p.split("/").filter((s) => s.length > 0);
}

function joinPath(...segments: string[]): string {
  return "/" + segments.join("/");
}

/**
 * Find the longest common parent directory among all paths.
 * Returns "/" if there's no common prefix beyond root.
 */
function commonPathPrefix(paths: string[]): string {
  if (paths.length === 0) return "/";

  const split = paths.map(splitPath);
  const minLength = Math.min(...split.map((s) => s.length));
  let commonLen = 0;

  for (let i = 0; i < minLength; i++) {
    const segment = split[0]?.[i];
    if (segment === undefined) break;
    if (split.every((s) => s[i] === segment)) {
      commonLen++;
    } else {
      break;
    }
  }

  // Use parent of the common prefix so the last shared segment
  // appears as a directory in the tree
  if (commonLen > 0) commonLen--;

  if (commonLen === 0) return "/";
  return joinPath(...(split[0]?.slice(0, commonLen) ?? []));
}

/**
 * Convert the internal branch tree into TreeNode[], embedding project rooms.
 */
function branchToNodesWithRooms(
  branch: Branch,
  prefix: string,
  currentPath: string,
  projectRoomsByPath: Map<string, Room>,
): TreeNode[] {
  const nodes: TreeNode[] = [];

  // Subdirectories
  for (const [name, child] of branch.children) {
    const childPath =
      currentPath === "" && prefix === "/"
        ? "/" + name
        : currentPath === ""
          ? prefix + "/" + name
          : currentPath + "/" + name;

    const childNodes = branchToNodesWithRooms(child, prefix, childPath, projectRoomsByPath);
    if (childNodes.length > 0) {
      // Check if this directory has a project room
      const room = projectRoomsByPath.get(childPath);
      nodes.push({
        type: "directory",
        name,
        path: childPath,
        ...(room ? { roomId: room.id } : {}),
        children: sortChildren(childNodes),
      });
    }
  }

  // Agents in this directory
  for (const agent of branch.agents) {
    nodes.push({
      type: "agent",
      name: agent.name,
      agentId: agent.id,
      status: agent.status,
      cwd: agent.cwd,
    });
  }

  return nodes;
}

function sortChildren(nodes: TreeNode[]): TreeNode[] {
  return [...nodes].sort((a, b) => {
    // Directories first, then agents
    if (a.type !== b.type) {
      return a.type === "directory" ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}

/**
 * ProjectTree — recursive tree view of agents grouped by working directory.
 *
 * Shows directories as expandable/collapsible nodes with agents nested inside.
 * Manual rooms appear in a separate flat list below the tree.
 */

import { useState } from "preact/hooks";
import type {
  AgentNode,
  DirectoryNode,
  ProjectTree as ProjectTreeData,
  TreeNode,
} from "../types.js";
import { inputFromEvent } from "../dom.js";

interface ProjectTreeProps {
  tree: ProjectTreeData;
  onJoinRoom: (roomId: string) => void;
  onSelectAgent: (agentId: string) => void;
  onRenameAgent: (agentId: string, newName: string) => void;
  currentRoom: string | undefined;
}

export function ProjectTree({
  tree,
  onJoinRoom,
  onSelectAgent,
  onRenameAgent,
  currentRoom,
}: ProjectTreeProps) {
  return (
    <div id="room-list" class="project-tree">
      {tree.roots.map((node) => (
        <TreeNodeView
          node={node}
          onJoinRoom={onJoinRoom}
          onSelectAgent={onSelectAgent}
          onRenameAgent={onRenameAgent}
          currentRoom={currentRoom}
        />
      ))}
      {tree.manualRooms.length > 0 && (
        <div class="tree-section">
          <h3 class="tree-section-heading">Rooms</h3>
          {tree.manualRooms.map((room) => (
            <div
              key={room.id}
              class={"room-item" + (currentRoom === room.id ? " active" : "")}
              onClick={() => {
                onJoinRoom(room.id);
              }}
            >
              <span>{room.name}</span>
              <span>({String(room.members.length)})</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TreeNodeView — recursive renderer for a single tree node
// ---------------------------------------------------------------------------

interface TreeNodeViewProps {
  node: TreeNode;
  onJoinRoom: (roomId: string) => void;
  onSelectAgent: (agentId: string) => void;
  onRenameAgent: (agentId: string, newName: string) => void;
  currentRoom: string | undefined;
}

function TreeNodeView({
  node,
  onJoinRoom,
  onSelectAgent,
  onRenameAgent,
  currentRoom,
}: TreeNodeViewProps) {
  if (node.type === "agent") {
    return (
      <AgentView
        node={node}
        onSelectAgent={onSelectAgent}
        onRenameAgent={onRenameAgent}
      />
    );
  }

  return (
    <DirectoryView
      node={node}
      onJoinRoom={onJoinRoom}
      onSelectAgent={onSelectAgent}
      onRenameAgent={onRenameAgent}
      currentRoom={currentRoom}
    />
  );
}

// ---------------------------------------------------------------------------
// DirectoryView
// ---------------------------------------------------------------------------

interface DirectoryViewProps {
  node: DirectoryNode;
  onJoinRoom: (roomId: string) => void;
  onSelectAgent: (agentId: string) => void;
  onRenameAgent: (agentId: string, newName: string) => void;
  currentRoom: string | undefined;
}

function DirectoryView({
  node,
  onJoinRoom,
  onSelectAgent,
  onRenameAgent,
  currentRoom,
}: DirectoryViewProps) {
  const [expanded, setExpanded] = useState(true);

  const hasRoom = node.roomId !== undefined;
  const isCurrentRoom = currentRoom === node.roomId;

  return (
    <div class="tree-directory">
      <div class="tree-directory-name">
        <span
          class="tree-folder-toggle"
          title="Expand/collapse"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(!expanded);
          }}
        >
          <span class="tree-folder-icon">{expanded ? "📂" : "📁"}</span>
        </span>
        <span
          class={`tree-directory-label${isCurrentRoom ? " active" : ""}${hasRoom ? " clickable" : ""}`}
          onClick={() => {
            if (node.roomId) onJoinRoom(node.roomId);
          }}
        >
          {node.name}
        </span>
      </div>
      {expanded && (
        <div class="tree-children">
          {node.children.map((child) => (
            <TreeNodeView
              key={child.type === "agent" ? child.agentId : child.path}
              node={child}
              onJoinRoom={onJoinRoom}
              onSelectAgent={onSelectAgent}
              onRenameAgent={onRenameAgent}
              currentRoom={currentRoom}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AgentView
// ---------------------------------------------------------------------------

interface AgentViewProps {
  node: AgentNode;
  onSelectAgent: (agentId: string) => void;
  onRenameAgent: (agentId: string, newName: string) => void;
}

function AgentView({ node, onSelectAgent, onRenameAgent }: AgentViewProps) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");

  const handleDoubleClick = () => {
    setEditName(node.name);
    setEditing(true);
  };

  const handleSubmit = () => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== node.name) {
      onRenameAgent(node.agentId, trimmed);
    }
    setEditing(false);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") handleSubmit();
    if (e.key === "Escape") setEditing(false);
  };

  if (editing) {
    return (
      <div class="tree-agent agent-item editing">
        <span class={`status-dot ${node.status}`} />
        <input
          class="agent-rename-input"
          type="text"
          value={editName}
          autofocus
          onInput={(e) => {
            setEditName(inputFromEvent(e).value);
          }}
          onKeyDown={handleKeyDown}
          onBlur={handleSubmit}
        />
      </div>
    );
  }

  return (
    <div
      class="tree-agent agent-item"
      onClick={() => {
        onSelectAgent(node.agentId);
      }}
      onDblClick={handleDoubleClick}
    >
      <span class={`status-dot ${node.status}`} />
      <span>{node.name}</span>
    </div>
  );
}

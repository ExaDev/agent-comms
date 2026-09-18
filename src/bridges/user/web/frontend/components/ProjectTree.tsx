/**
 * ProjectTree — recursive tree view of agents grouped by working directory.
 *
 * Shows directories as expandable/collapsible nodes with agents nested inside. Manual rooms appear in a separate flat list below the tree.
 */

import { Box, NavLink, Text, TextInput } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import type {
  AgentNode,
  DirectoryNode,
  ProjectTree as ProjectTreeData,
  TreeNode,
} from "../types.js";

interface ProjectTreeProps {
  tree: ProjectTreeData;
  onJoinRoom: (roomId: string) => void;
  onSelectAgent: (agentId: string) => void;
  onRenameAgent: (agentId: string, newName: string) => void;
  currentRoom: string | undefined;
}

const STATUS_DOT_COLORS: Record<AgentNode["status"], string> = {
  active: "green",
  idle: "yellow",
  busy: "red",
  offline: "gray",
};

function StatusDot({ status }: { status: AgentNode["status"] }) {
  return (
    <Box
      w={8}
      h={8}
      style={{
        borderRadius: "50%",
        backgroundColor: `var(--mantine-color-${STATUS_DOT_COLORS[status]}-6)`,
      }}
    />
  );
}

export function ProjectTree({
  tree,
  onJoinRoom,
  onSelectAgent,
  onRenameAgent,
  currentRoom,
}: ProjectTreeProps) {
  return (
    <Box mb="xs">
      {tree.roots.map((node) => (
        <TreeNodeView
          key={node.type === "agent" ? node.agentId : node.path}
          node={node}
          onJoinRoom={onJoinRoom}
          onSelectAgent={onSelectAgent}
          onRenameAgent={onRenameAgent}
          currentRoom={currentRoom}
        />
      ))}
      {tree.manualRooms.length > 0 && (
        <Box py={4}>
          <Text size="xs" c="dimmed" fw={700} tt="uppercase" px="xs" py={4}>
            Rooms
          </Text>
          {tree.manualRooms.map((room) => (
            <NavLink
              key={room.id}
              label={`${room.name} (${String(room.members.length)})`}
              active={currentRoom === room.id}
              onClick={() => {
                onJoinRoom(room.id);
              }}
            />
          ))}
        </Box>
      )}
    </Box>
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
  const roomId = node.roomId;
  const isCurrentRoom = currentRoom === roomId;
  const clickProps =
    roomId === undefined
      ? {}
      : {
          onClick: () => {
            onJoinRoom(roomId);
          },
        };

  return (
    <NavLink
      label={node.name}
      leftSection={<span aria-hidden="true">📁</span>}
      defaultOpened
      active={isCurrentRoom}
      {...clickProps}
    >
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
    </NavLink>
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
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) renameInputRef.current?.focus();
  }, [editing]);

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

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") handleSubmit();
    if (e.key === "Escape") setEditing(false);
  };

  if (editing) {
    return (
      <TextInput
        ref={renameInputRef}
        size="xs"
        ml="md"
        aria-label={`Rename ${node.name}`}
        value={editName}
        onChange={(e) => {
          setEditName(e.target.value);
        }}
        onKeyDown={handleKeyDown}
        onBlur={handleSubmit}
      />
    );
  }

  return (
    <NavLink
      label={node.name}
      leftSection={<StatusDot status={node.status} />}
      onClick={() => {
        onSelectAgent(node.agentId);
      }}
      onDoubleClick={handleDoubleClick}
    />
  );
}

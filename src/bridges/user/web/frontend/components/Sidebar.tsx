/**
 * Sidebar — project tree, manual rooms, create/join room controls.
 *
 * Rendered inside AppShell.Navbar by App.
 */

import { ActionIcon, Button, Group, ScrollArea, Text } from "@mantine/core";
import { useState } from "react";
import type { Agent, Room } from "../types.js";
import { buildProjectTree } from "../project-tree.js";
import { CreateRoomForm } from "./CreateRoomForm.js";
import { JoinForm } from "./JoinForm.js";
import { ProjectTree } from "./ProjectTree.js";

interface SidebarProps {
  rooms: readonly Room[];
  agents: readonly Agent[];
  currentRoom: string | undefined;
  onJoinRoom: (roomId: string) => void;
  onSelectAgent: (agentId: string) => void;
  onRenameAgent: (agentId: string, newName: string) => void;
  onCreateRoom: (
    name: string,
    type: "public" | "private" | "secret",
    description: string,
  ) => void;
  onJoinRoomInput: (roomName: string) => void;
}

export function Sidebar({
  rooms,
  agents,
  currentRoom,
  onJoinRoom,
  onSelectAgent,
  onRenameAgent,
  onCreateRoom,
  onJoinRoomInput,
}: SidebarProps) {
  const [createFormVisible, setCreateFormVisible] = useState(false);
  const [joinFormVisible, setJoinFormVisible] = useState(false);
  const [showOffline, setShowOffline] = useState(false);
  const visibleAgents = showOffline
    ? agents
    : agents.filter((a) => a.status !== "offline");
  const tree = buildProjectTree(visibleAgents, rooms);

  return (
    <>
      <Group justify="space-between" px="md" py="sm">
        <Text size="sm" fw={600} c="accent">
          Agent Comms
        </Text>
        <ActionIcon
          variant={showOffline ? "filled" : "default"}
          size="sm"
          aria-label={`${showOffline ? "Hide" : "Show"} offline agents`}
          title={`${showOffline ? "Hide" : "Show"} offline agents`}
          onClick={() => {
            setShowOffline((v) => !v);
          }}
        >
          {showOffline ? "◉" : "◎"}
        </ActionIcon>
      </Group>
      <ScrollArea flex={1} px="xs">
        <ProjectTree
          tree={tree}
          onJoinRoom={onJoinRoom}
          onSelectAgent={onSelectAgent}
          onRenameAgent={onRenameAgent}
          currentRoom={currentRoom}
        />
        <Group justify="space-between" px="xs" py={4}>
          <Text size="xs" c="dimmed" fw={700} tt="uppercase">
            Create
          </Text>
          <ActionIcon
            variant="default"
            size="sm"
            aria-label="Create room"
            title="Create room"
            onClick={() => {
              setCreateFormVisible((v) => !v);
            }}
          >
            +
          </ActionIcon>
        </Group>
        <CreateRoomForm
          visible={createFormVisible}
          onSubmit={(name, type, desc) => {
            onCreateRoom(name, type, desc);
            setCreateFormVisible(false);
          }}
          onCancel={() => {
            setCreateFormVisible(false);
          }}
        />
        <Button
          fullWidth
          size="xs"
          variant="outline"
          onClick={() => {
            setJoinFormVisible((v) => !v);
          }}
        >
          + Join Room
        </Button>
        <JoinForm
          visible={joinFormVisible}
          onSubmit={(name) => {
            onJoinRoomInput(name);
            setJoinFormVisible(false);
          }}
          onCancel={() => {
            setJoinFormVisible(false);
          }}
        />
      </ScrollArea>
    </>
  );
}

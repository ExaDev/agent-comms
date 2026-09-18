/**
 * ChatArea — main chat panel with header, messages, and input.
 */

import { Burger, Button, Group, Stack, Text, TextInput } from "@mantine/core";
import { useState } from "react";
import type { DisplayMessage } from "../types.js";
import { parseInput } from "../input.js";
import { MessageList } from "./MessageList.js";

interface ChatAreaProps {
  messages: readonly DisplayMessage[];
  currentRoom: string | undefined;
  dmTarget: string | undefined;
  connected: boolean;
  sidebarOpened: boolean;
  onToggleSidebar: () => void;
  onSendAction: (text: string) => void;
  onLeaveRoom: () => void;
  onConnectToMesh: () => void;
}

export function ChatArea({
  messages,
  currentRoom,
  dmTarget,
  connected,
  sidebarOpened,
  onToggleSidebar,
  onSendAction,
  onLeaveRoom,
  onConnectToMesh,
}: ChatAreaProps) {
  const [inputText, setInputText] = useState("");

  const headerText =
    currentRoom ??
    (dmTarget !== undefined ? `DM with ${dmTarget}` : "Select a room");

  const handleSend = () => {
    const trimmed = inputText.trim();
    if (!trimmed) return;
    const result = parseInput(trimmed, currentRoom, dmTarget);
    switch (result.kind) {
      case "action":
        onSendAction(trimmed);
        break;
      case "local":
        // Local commands are handled by adding a system message
        onSendAction(trimmed);
        break;
      case "ignored":
        break;
    }
    setInputText("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") handleSend();
  };

  return (
    <Stack h="100%" gap={0}>
      <Group
        component="header"
        justify="space-between"
        px="md"
        py="sm"
        bg="dark.6"
      >
        <Group gap="sm">
          <Burger
            opened={sidebarOpened}
            onClick={onToggleSidebar}
            size="sm"
            aria-label="Toggle sidebar"
          />
          <Text fw={600}>{headerText}</Text>
        </Group>
        {currentRoom !== undefined && (
          <Button size="xs" variant="subtle" onClick={onLeaveRoom}>
            Leave
          </Button>
        )}
      </Group>
      <MessageList messages={messages} />
      {!connected && messages.length === 0 && (
        <Stack align="center" justify="center" gap="md" p="xl">
          <Text c="dimmed">
            Connect to a local mesh to discover agents and rooms.
          </Text>
          <Button variant="outline" onClick={onConnectToMesh}>
            Connect to local mesh
          </Button>
        </Stack>
      )}
      <Group px="md" py="sm" gap="xs" bg="dark.6">
        <TextInput
          flex={1}
          placeholder="Type a message or /command..."
          aria-label="Message"
          autoComplete="off"
          value={inputText}
          onChange={(e) => {
            setInputText(e.target.value);
          }}
          onKeyDown={handleKeyDown}
        />
        <Button onClick={handleSend}>Send</Button>
      </Group>
    </Stack>
  );
}

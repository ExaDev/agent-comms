/**
 * ChatArea — main chat panel with header, messages, and input.
 */

import {
  BRIDGE_PORT_BASE,
  bridgePairingPageUrl,
} from "../../bridge-port-range.js";
import { Burger, Button, Group, Stack, Text } from "@mantine/core";
import { SubmitRow } from "web-ui-primitives";
import type { DisplayMessage, Room } from "../types.js";
import { parseInput } from "../input.js";
import { MessageList } from "./MessageList.js";

interface ChatAreaProps {
  messages: readonly DisplayMessage[];
  rooms: readonly Room[];
  currentRoom: string | undefined;
  dmTarget: string | undefined;
  connected: boolean;
  sidebarOpened: boolean;
  onToggleSidebar: () => void;
  onSendAction: (text: string) => void;
  onLeaveRoom: () => void;
  onConnectToMesh: () => void;
  /** True for the hosted dashboard in a browser that was never paired with a bridge: it shows how to pair instead of offering to connect. */
  pairingNeeded: boolean;
}

export function ChatArea({
  messages,
  rooms,
  currentRoom,
  dmTarget,
  connected,
  sidebarOpened,
  onToggleSidebar,
  onSendAction,
  onLeaveRoom,
  onConnectToMesh,
  pairingNeeded,
}: ChatAreaProps) {
  // currentRoom is the room's real owner-qualified id (`<owner-hex>/<local-name>`), not something meant for display -- resolve it back to the plain name the room was created with, the same name the sidebar list already shows, rather than surfacing the internal id verbatim.
  const currentRoomName =
    currentRoom === undefined
      ? undefined
      : (rooms.find((room) => room.id === currentRoom)?.name ?? currentRoom);

  const headerText =
    currentRoomName ??
    (dmTarget !== undefined ? `DM with ${dmTarget}` : "Select a room");

  const handleSend = (trimmed: string): void => {
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
      {!connected && messages.length === 0 && pairingNeeded && (
        <Stack align="center" justify="center" gap="md" p="xl">
          <Text fw={600}>Pair this browser with your bridge</Text>
          <Text c="dimmed" ta="center">
            The hosted dashboard talks only to a bridge it has been paired with.
            On the machine running the bridge, open the address the bridge
            printed with /pair on the end (for the first bridge,{" "}
            <a href={bridgePairingPageUrl(BRIDGE_PORT_BASE)}>
              {bridgePairingPageUrl(BRIDGE_PORT_BASE)}
            </a>
            ) and press Pair this browser. Run agent-comms pairing rotate to
            revoke every pairing.
          </Text>
          <Text c="dimmed" ta="center" size="sm">
            If that address answers 404 or nothing, the bridge is older than
            pairing: update agent-comms to its latest release, restart the
            bridge, and open the address again.
          </Text>
          <Button variant="outline" onClick={onConnectToMesh}>
            Try again
          </Button>
        </Stack>
      )}

      {!connected && messages.length === 0 && !pairingNeeded && (
        <Stack align="center" justify="center" gap="md" p="xl">
          <Text c="dimmed">
            Connect to a local mesh to discover agents and rooms.
          </Text>
          <Button variant="outline" onClick={onConnectToMesh}>
            Connect to local mesh
          </Button>
        </Stack>
      )}
      <Group px="md" py="sm" bg="dark.6">
        <SubmitRow
          ariaLabel="Message"
          placeholder="Type a message or /command..."
          submitLabel="Send"
          onSubmit={handleSend}
        />
      </Group>
    </Stack>
  );
}

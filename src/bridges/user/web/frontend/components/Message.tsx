/**
 * Message — renders a single display message.
 */

import { Badge, Group, Text } from "@mantine/core";
import type { DisplayMessage } from "../types.js";
import { formatTime } from "../messages.js";

export function Message({ message }: { message: DisplayMessage }) {
  switch (message.type) {
    case "chat":
      return (
        <Group gap="xs" wrap="wrap" align="baseline">
          <Text fw={600} c="accent" span>
            {message.sender}
          </Text>
          <Text c="dimmed" size="xs" span>
            {formatTime(message.timestamp)}
          </Text>
          <Text span>: {message.content}</Text>
        </Group>
      );
    case "dm":
      return (
        <Group gap="xs" wrap="wrap" align="baseline">
          <Badge color="grape" size="xs">
            DM
          </Badge>
          <Text fw={600} c="accent" span>
            {message.sender}
          </Text>
          <Text c="dimmed" size="xs" span>
            {formatTime(message.timestamp)}
          </Text>
          <Text span>: {message.content}</Text>
        </Group>
      );
    case "system":
      return (
        <Text c="dimmed" fs="italic" size="sm">
          {message.text}
        </Text>
      );
    case "status":
      return (
        <Text c="yellow" size="xs">
          {message.text}
        </Text>
      );
  }
}

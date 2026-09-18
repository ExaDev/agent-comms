/**
 * JoinForm — inline form for joining a room by name.
 */

import { Button, Group, TextInput } from "@mantine/core";
import { useState } from "react";

interface JoinFormProps {
  visible: boolean;
  onSubmit: (roomName: string) => void;
  onCancel: () => void;
}

export function JoinForm({ visible, onSubmit, onCancel }: JoinFormProps) {
  const [roomName, setRoomName] = useState("");

  if (!visible) return null;

  const handleSubmit = () => {
    const trimmed = roomName.trim();
    if (trimmed) {
      onSubmit(trimmed);
      setRoomName("");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") handleSubmit();
    if (e.key === "Escape") onCancel();
  };

  return (
    <Group gap="xs" py={4}>
      <TextInput
        flex={1}
        size="xs"
        placeholder="Room name..."
        aria-label="Room name"
        autoComplete="off"
        value={roomName}
        onChange={(e) => {
          setRoomName(e.target.value);
        }}
        onKeyDown={handleKeyDown}
      />
      <Button size="xs" onClick={handleSubmit}>
        Join
      </Button>
    </Group>
  );
}

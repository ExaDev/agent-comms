/**
 * CreateRoomForm — inline form for creating a new room.
 */

import { Button, Group, Select, Stack, TextInput } from "@mantine/core";
import { useState } from "react";

interface CreateRoomFormProps {
  visible: boolean;
  onSubmit: (
    name: string,
    type: "public" | "private" | "secret",
    description: string,
  ) => void;
  onCancel: () => void;
}

const ROOM_TYPE_OPTIONS = [
  { value: "public", label: "Public" },
  { value: "private", label: "Private" },
  { value: "secret", label: "Secret" },
];

function isRoomType(
  value: string | null,
): value is "public" | "private" | "secret" {
  return value === "public" || value === "private" || value === "secret";
}

export function CreateRoomForm({
  visible,
  onSubmit,
  onCancel,
}: CreateRoomFormProps) {
  const [name, setName] = useState("");
  const [roomType, setRoomType] = useState<"public" | "private" | "secret">(
    "public",
  );
  const [description, setDescription] = useState("");

  if (!visible) return null;

  const handleSubmit = (e: React.SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!name.trim()) return;
    onSubmit(name.trim(), roomType, description.trim());
    setName("");
    setRoomType("public");
    setDescription("");
  };

  return (
    <form onSubmit={handleSubmit}>
      <Stack gap="xs" p="xs">
        <TextInput
          label="Room name"
          name="room-name"
          required
          placeholder="e.g. project-alpha"
          size="xs"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
        />
        <Select
          label="Type"
          name="room-type"
          size="xs"
          data={ROOM_TYPE_OPTIONS}
          value={roomType}
          allowDeselect={false}
          onChange={(value) => {
            if (isRoomType(value)) setRoomType(value);
          }}
        />
        <TextInput
          label="Description (optional)"
          name="room-description"
          placeholder="What is this room about?"
          size="xs"
          value={description}
          onChange={(e) => {
            setDescription(e.target.value);
          }}
        />
        <Group gap="xs">
          <Button type="submit" size="xs" flex={1}>
            Create
          </Button>
          <Button
            type="button"
            size="xs"
            flex={1}
            variant="default"
            onClick={onCancel}
          >
            Cancel
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

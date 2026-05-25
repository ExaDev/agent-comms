/**
 * CreateRoomForm — inline form for creating a new room.
 */

import { useState } from "preact/hooks";
import { inputFromEvent } from "../dom.js";

interface CreateRoomFormProps {
  visible: boolean;
  onSubmit: (
    name: string,
    type: "public" | "private" | "secret",
    description: string,
  ) => void;
  onCancel: () => void;
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

  const handleSubmit = (e: Event) => {
    e.preventDefault();
    if (!name.trim()) return;
    onSubmit(name.trim(), roomType, description.trim());
    setName("");
    setRoomType("public");
    setDescription("");
  };

  return (
    <div id="create-room-form" class="visible">
      <form class="create-room-form" onSubmit={handleSubmit}>
        <label>
          Room name
          <input
            type="text"
            name="room-name"
            required
            placeholder="e.g. project-alpha"
            value={name}
            onInput={(e) => {
              setName((e.target as HTMLInputElement).value);
            }}
          />
        </label>
        <label>
          Type
          <select
            name="room-type"
            value={roomType}
            onChange={(e) => {
              setRoomType(
                (e.target as HTMLSelectElement).value as
                  | "public"
                  | "private"
                  | "secret",
              );
            }}
          >
            <option value="public">Public</option>
            <option value="private">Private</option>
            <option value="secret">Secret</option>
          </select>
        </label>
        <label>
          Description (optional)
          <input
            type="text"
            name="room-description"
            placeholder="What is this room about?"
            value={description}
            onInput={(e) => {
              setDescription((e.target as HTMLInputElement).value);
            }}
          />
        </label>
        <div class="create-room-btns">
          <button type="submit" class="create-room-submit">
            Create
          </button>
          <button type="button" class="create-room-cancel" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

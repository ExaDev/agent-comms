/**
 * JoinForm — inline form for joining a room by name.
 */

import { useState } from "preact/hooks";
import { inputFromEvent } from "../dom.js";

interface JoinFormProps {
  visible: boolean;
  onSubmit: (roomName: string) => void;
  onCancel: () => void;
}

export function JoinForm({ visible, onSubmit, onCancel }: JoinFormProps) {
  const [roomName, setRoomName] = useState("");

  if (!visible) return <div id="join-form" class="join-form hidden" />;

  const handleSubmit = () => {
    const trimmed = roomName.trim();
    if (trimmed) {
      onSubmit(trimmed);
      setRoomName("");
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") handleSubmit();
    if (e.key === "Escape") onCancel();
  };

  return (
    <div id="join-form" class="join-form">
      <input
        class="join-input"
        type="text"
        placeholder="Room name..."
        autocomplete="off"
        value={roomName}
        onInput={(e) => {
          setRoomName((e.target as HTMLInputElement).value);
        }}
        onKeyDown={handleKeyDown}
      />
      <button class="join-submit" onClick={handleSubmit}>
        Join
      </button>
    </div>
  );
}

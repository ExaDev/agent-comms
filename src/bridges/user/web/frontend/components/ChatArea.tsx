/**
 * ChatArea — main chat panel with header, messages, and input.
 */

import { useState } from "preact/hooks";
import type { DisplayMessage } from "../types.js";
import { inputFromEvent } from "../dom.js";
import { parseInput } from "../input.js";
import { MessageList } from "./MessageList.js";

interface ChatAreaProps {
  messages: DisplayMessage[];
  currentRoom: string | undefined;
  dmTarget: string | undefined;
  connected: boolean;
  onSendAction: (text: string) => void;
  onLeaveRoom: () => void;
  onConnectToMesh: () => void;
}

export function ChatArea({
  messages,
  currentRoom,
  dmTarget,
  connected,
  onSendAction,
  onLeaveRoom,
  onConnectToMesh,
}: ChatAreaProps) {
  const [inputText, setInputText] = useState("");

  const headerText =
    currentRoom ?? (dmTarget ? `DM with ${dmTarget}` : "Select a room");

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

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") handleSend();
  };

  return (
    <div id="main">
      <div id="header">
        {headerText}
        {currentRoom && (
          <button class="leave-btn" onClick={onLeaveRoom}>
            Leave
          </button>
        )}
      </div>
      <MessageList messages={messages} />
      {!connected && messages.length === 0 && (
        <div class="connect-prompt">
          <p>Connect to a local mesh to discover agents and rooms.</p>
          <button class="connect-btn" onClick={onConnectToMesh}>
            Connect to local mesh
          </button>
        </div>
      )}
      <div id="input-bar">
        <input
          id="input"
          type="text"
          placeholder="Type a message or /command..."
          autocomplete="off"
          value={inputText}
          onInput={(e) => {
            setInputText(inputFromEvent(e).value);
          }}
          onKeyDown={handleKeyDown}
        />
        <button id="send-btn" onClick={handleSend}>
          Send
        </button>
      </div>
    </div>
  );
}

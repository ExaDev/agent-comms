/**
 * Message — renders a single display message.
 */

import type { DisplayMessage } from "../types.js";
import { formatTime } from "../dom.js";

export function Message({ message }: { message: DisplayMessage }) {
  switch (message.type) {
    case "chat":
      return (
        <div class="msg">
          <span class="sender">{message.sender}</span>
          <span class="time">{formatTime(message.timestamp)}</span>:{" "}
          {message.content}
        </div>
      );
    case "dm":
      return (
        <div class="msg dm">
          <span class="dm-badge">DM</span>{" "}
          <span class="sender">{message.sender}</span>
          <span class="time">{formatTime(message.timestamp)}</span>:{" "}
          {message.content}
        </div>
      );
    case "system":
      return <div class="msg system">{message.text}</div>;
    case "status":
      return <div class="msg status">{message.text}</div>;
  }
}

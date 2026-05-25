/**
 * Message conversion — transforms wire-format events into display messages.
 *
 * Pure functions, no DOM or state dependency. Testable in isolation.
 */

import type { DeliveryEvent, DisplayMessage, RoomMessage } from "./types.js";

/**
 * Convert a delivery event to a display message for the UI.
 * Returns undefined if the event should not be displayed
 * (e.g. room_message for a room that isn't currently active).
 */
export function deliveryEventToMessage(
  event: DeliveryEvent,
  currentRoom: string | undefined,
): DisplayMessage | undefined {
  switch (event.type) {
    case "room_message":
      if (currentRoom === event.message.room) {
        return {
          type: "chat",
          sender: event.message.from,
          content: event.message.content,
          timestamp: event.message.timestamp,
        };
      }
      return undefined;

    case "dm":
      return {
        type: "dm",
        sender: event.message.from,
        content: event.message.content,
        timestamp: event.message.timestamp,
      };

    case "member_joined":
      return { type: "system", text: `${event.agent} joined ${event.room}` };

    case "member_left":
      return { type: "system", text: `${event.agent} left ${event.room}` };

    case "member_status":
      return {
        type: "status",
        text: `${event.agent} is now ${event.status} in ${event.room}`,
      };

    case "delivery_status":
      return {
        type: "status",
        text: `Message ${event.messageId} ${event.status} by ${event.agent}`,
      };

    case "room_members":
      if (currentRoom === event.room) {
        const memberList = event.members
          .map((m) => `${m.name} (${m.status})`)
          .join(", ");
        return { type: "system", text: `Members: ${memberList}` };
      }
      return undefined;

    case "room_invite": {
      const desc = event.roomDescription ? ` — ${event.roomDescription}` : "";
      return {
        type: "system",
        text: `${event.fromName} invited you to "${event.room}"${desc}`,
      };
    }

    case "invite_declined":
      return {
        type: "system",
        text: `${event.agentName} declined invite to ${event.room}: "${event.reason}"`,
      };

    case "name_changed":
      return {
        type: "system",
        text: `${event.oldName} is now known as ${event.newName}`,
      };
  }
}

/**
 * Convert a room message (from REST API history) to a display message.
 */
export function roomMessageToDisplay(m: RoomMessage): DisplayMessage {
  return {
    type: "chat",
    sender: m.from,
    content: m.content,
    timestamp: m.timestamp,
  };
}

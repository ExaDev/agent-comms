/**
 * Render functions — pure DOM construction from state and data.
 *
 * Every function takes a document (or element) and data, returns DOM nodes.
 * No side effects, no global state. Testable with jsdom.
 */

import type { Agent, DeliveryEvent, Room, RoomMessage } from "./types.js";
import { clearChildren, createElement, escapeHtml, formatTime } from "./dom.js";

// ---------------------------------------------------------------------------
// Message rendering
// ---------------------------------------------------------------------------

export interface MessageTarget {
  messagesEl: HTMLElement;
}

export function renderChatMessage(
  doc: Document,
  target: MessageTarget,
  sender: string,
  content: string,
  timestamp: string,
): void {
  const time = formatTime(timestamp);
  const div = doc.createElement("div");
  div.className = "msg";
  div.innerHTML = `<span class="sender">${escapeHtml(doc, sender)}</span><span class="time">${time}</span>: ${escapeHtml(doc, content)}`;
  target.messagesEl.appendChild(div);
  target.messagesEl.scrollTop = target.messagesEl.scrollHeight;
}

export function renderDmMessage(
  doc: Document,
  target: MessageTarget,
  sender: string,
  content: string,
  timestamp: string,
): void {
  const time = formatTime(timestamp);
  const div = doc.createElement("div");
  div.className = "msg dm";
  div.innerHTML = `<span class="dm-badge">DM</span> <span class="sender">${escapeHtml(doc, sender)}</span><span class="time">${time}</span>: ${escapeHtml(doc, content)}`;
  target.messagesEl.appendChild(div);
  target.messagesEl.scrollTop = target.messagesEl.scrollHeight;
}

export function renderSystemMessage(
  doc: Document,
  target: MessageTarget,
  text: string,
): void {
  const div = doc.createElement("div");
  div.className = "msg system";
  div.textContent = text;
  target.messagesEl.appendChild(div);
  target.messagesEl.scrollTop = target.messagesEl.scrollHeight;
}

export function renderStatusMessage(
  doc: Document,
  target: MessageTarget,
  text: string,
): void {
  const div = doc.createElement("div");
  div.className = "msg status";
  div.textContent = text;
  target.messagesEl.appendChild(div);
  target.messagesEl.scrollTop = target.messagesEl.scrollHeight;
}

export function clearMessages(target: MessageTarget): void {
  clearChildren(target.messagesEl);
}

// ---------------------------------------------------------------------------
// Delivery event rendering
// ---------------------------------------------------------------------------

export function renderDeliveryEvent(
  doc: Document,
  target: MessageTarget,
  event: DeliveryEvent,
  currentRoom: string | undefined,
): void {
  switch (event.type) {
    case "room_message":
      if (currentRoom === event.message.room) {
        renderChatMessage(
          doc,
          target,
          event.message.from,
          event.message.content,
          event.message.timestamp,
        );
      }
      break;

    case "dm":
      renderDmMessage(
        doc,
        target,
        event.message.from,
        event.message.content,
        event.message.timestamp,
      );
      break;

    case "member_joined":
      renderSystemMessage(doc, target, `${event.agent} joined ${event.room}`);
      break;

    case "member_left":
      renderSystemMessage(doc, target, `${event.agent} left ${event.room}`);
      break;

    case "member_status":
      renderStatusMessage(
        doc,
        target,
        `${event.agent} is now ${event.status} in ${event.room}`,
      );
      break;

    case "delivery_status":
      renderStatusMessage(
        doc,
        target,
        `Message ${event.messageId} ${event.status} by ${event.agent}`,
      );
      break;

    case "room_members":
      if (currentRoom === event.room) {
        const memberList = event.members
          .map((m) => `${m.name} (${m.status})`)
          .join(", ");
        renderSystemMessage(doc, target, `Members: ${memberList}`);
      }
      break;

    case "room_invite": {
      const desc = event.roomDescription ? ` — ${event.roomDescription}` : "";
      renderSystemMessage(
        doc,
        target,
        `${event.fromName} invited you to "${event.room}"${desc}`,
      );
      break;
    }

    case "invite_declined":
      renderSystemMessage(
        doc,
        target,
        `${event.agentName} declined invite to ${event.room}: "${event.reason}"`,
      );
      break;
  }
}

// ---------------------------------------------------------------------------
// Sidebar rendering
// ---------------------------------------------------------------------------

export interface SidebarTarget {
  roomListEl: HTMLElement;
  agentListEl: HTMLElement;
}

export type RoomAction = (roomId: string) => void | Promise<void>;

export function renderRoomList(
  doc: Document,
  target: SidebarTarget,
  rooms: Room[],
  currentRoom: string | undefined,
  onJoin: RoomAction,
): void {
  clearChildren(target.roomListEl);

  for (const room of rooms) {
    const isActive = currentRoom === room.id;
    const typeIndicator = room.type.charAt(0).toUpperCase();
    const memberCount = room.members.length;

    const div = doc.createElement("div");
    div.className = `room-item${isActive ? " active" : ""}`;
    div.innerHTML = `${typeIndicator} ${escapeHtml(doc, room.name)} <span style="color:var(--dim)">(${String(memberCount)})</span>`;
    div.onclick = () => {
      void onJoin(room.id);
    };
    target.roomListEl.appendChild(div);
  }
}

export type AgentSelectAction = (agentId: string) => void;

export function renderAgentList(
  doc: Document,
  target: SidebarTarget,
  agents: Agent[],
  onSelect?: AgentSelectAction,
): void {
  clearChildren(target.agentListEl);

  for (const agent of agents) {
    const div = doc.createElement("div");
    div.className = "agent-item";

    const dot = createElement(doc, "span", {
      class: `status-dot ${agent.status}`,
    });

    const name = doc.createTextNode(` ${agent.name}`);
    div.appendChild(dot);
    div.appendChild(name);
    if (onSelect) {
      div.onclick = () => {
        onSelect(agent.id);
      };
    }
    target.agentListEl.appendChild(div);
  }
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

export interface HeaderTarget {
  headerEl: HTMLElement;
}

export function renderHeader(target: HeaderTarget, text: string): void {
  target.headerEl.textContent = text;
}

// ---------------------------------------------------------------------------
// Room history (batch load)
// ---------------------------------------------------------------------------

export function renderMessageHistory(
  doc: Document,
  target: MessageTarget,
  messages: RoomMessage[],
): void {
  for (const m of messages) {
    renderChatMessage(doc, target, m.from, m.content, m.timestamp);
  }
}

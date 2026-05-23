/**
 * Entry point — bootstraps the web UI.
 *
 * Imports all modules, binds DOM events, connects WebSocket,
 * and wires up the render loop.
 */

import "./styles.css";
import { CommsWs, fetchAgents, fetchRoomMessages, fetchRooms } from "./api.js";
import { requireElement } from "./dom.js";
import { parseInput } from "./input.js";
import {
  clearMessages,
  renderDeliveryEvent,
  renderHeader,
  renderMessageHistory,
  renderRoomList,
  renderAgentList,
  renderSystemMessage,
  renderStatusMessage,
} from "./render.js";
import { State } from "./state.js";
import type { Action, WsFrame } from "./types.js";

// ---------------------------------------------------------------------------
// DOM elements
// ---------------------------------------------------------------------------

const messagesEl = requireElement(document, "#messages");
const inputRaw = requireElement(document, "#input", "input");
const headerEl = requireElement(document, "#header");
const roomListEl = requireElement(document, "#room-list");
const agentListEl = requireElement(document, "#agent-list");

const messageTarget = { messagesEl };
const sidebarTarget = { roomListEl, agentListEl };

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = new State();

// Re-render sidebar on state changes
state.subscribe((s) => {
  renderRoomList(document, sidebarTarget, s.rooms, s.currentRoom, onJoinRoom);
  renderAgentList(document, sidebarTarget, s.agents, onSelectAgent);
});

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

const ws = new CommsWs({
  onOpen: () => {
    state.setConnected(true);
    renderSystemMessage(document, messageTarget, "Connected to mesh");
  },
  onClose: () => {
    state.setConnected(false);
    renderSystemMessage(
      document,
      messageTarget,
      "Disconnected — reconnecting...",
    );
  },
  onFrame: handleFrame,
});

function handleFrame(frame: WsFrame): void {
  switch (frame.type) {
    case "delivery":
      renderDeliveryEvent(
        document,
        messageTarget,
        frame.event,
        state.get().currentRoom,
      );
      // Some events require a state refresh
      if (
        frame.event.type === "member_joined" ||
        frame.event.type === "member_left" ||
        frame.event.type === "member_status"
      ) {
        void refreshState();
      }
      break;

    case "result":
      renderSystemMessage(document, messageTarget, frame.result.content);
      // Refresh sidebar after successful mutations (create, join, leave, etc.)
      if (!frame.result.isError) {
        void refreshState();
      }
      break;

    case "error":
      renderStatusMessage(document, messageTarget, `Error: ${frame.message}`);
      break;

    case "state":
      state.applyState(frame.agents, frame.rooms);
      break;
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function sendAction(action: Action): void {
  ws.sendAction(action);
}

async function refreshState(): Promise<void> {
  const [agents, rooms] = await Promise.all([fetchAgents(), fetchRooms()]);
  state.setAgents(agents);
  state.setRooms(rooms);
}

async function onJoinRoom(roomId: string): Promise<void> {
  state.setDmTarget(undefined);
  state.setCurrentRoom(roomId);
  renderHeader({ headerEl }, roomId);
  clearMessages(messageTarget);

  sendAction({ action: "join_room", room: roomId });

  // Load history
  const messages = await fetchRoomMessages(roomId);
  renderMessageHistory(document, messageTarget, messages);
  renderSystemMessage(document, messageTarget, `Joined ${roomId}`);
  inputRaw.focus();
}

function onSelectAgent(agentId: string): void {
  state.setCurrentRoom(undefined);
  state.setDmTarget(agentId);
  clearMessages(messageTarget);
  renderHeader({ headerEl }, `DM with ${agentId}`);
  inputRaw.focus();
}

// ---------------------------------------------------------------------------
// Input handling
// ---------------------------------------------------------------------------

function handleInput(): void {
  const text = inputRaw.value;
  inputRaw.value = "";

  const result = parseInput(
    text,
    state.get().currentRoom,
    state.get().dmTarget,
  );

  switch (result.kind) {
    case "action":
      sendAction(result.action);
      break;
    case "local":
      renderSystemMessage(document, messageTarget, result.result.text);
      break;
    case "ignored":
      break;
  }
}

const sendBtn = requireElement(document, "#send-btn");
sendBtn.onclick = handleInput;
inputRaw.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Enter") handleInput();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

ws.connect();
void refreshState();
inputRaw.focus();

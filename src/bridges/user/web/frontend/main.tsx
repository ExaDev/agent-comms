/**
 * Entry point — bootstraps the web UI with Preact.
 *
 * Owns the state store, WebSocket connection, and action handlers.
 * Renders the App component on every state change.
 */

import { render } from "preact";
import "./styles.css";
import { App } from "./components/App.js";
import { CommsWs, fetchAgents, fetchRoomMessages, fetchRooms } from "./api.js";
import { requireElement } from "./dom.js";
import { parseInput } from "./input.js";
import { State } from "./state.js";
import type { Action, DisplayMessage, WsFrame } from "./types.js";
import { deliveryEventToMessage, roomMessageToDisplay } from "./messages.js";

// ---------------------------------------------------------------------------
// Mount point
// ---------------------------------------------------------------------------

const rootEl = requireElement(document, "#root");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = new State();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addMessage(msg: DisplayMessage): void {
  state.addMessage(msg);
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

let pendingAction: Action | undefined;

const ws = new CommsWs({
  onOpen: () => {
    state.setConnected(true);
    addMessage({ type: "system", text: "Connected to mesh" });
  },
  onClose: () => {
    state.setConnected(false);
    addMessage({ type: "system", text: "Disconnected — reconnecting..." });
  },
  onFrame: handleFrame,
});

function handleFrame(frame: WsFrame): void {
  const s = state.get();

  switch (frame.type) {
    case "delivery": {
      const msg = deliveryEventToMessage(frame.event, s.currentRoom);
      if (msg) addMessage(msg);

      if (
        frame.event.type === "member_joined" ||
        frame.event.type === "member_left" ||
        frame.event.type === "member_status"
      ) {
        void refreshState();
      }
      break;
    }

    case "result":
      addMessage({ type: "system", text: frame.result.content });
      if (!frame.result.isError) {
        if (pendingAction?.action === "join_room" && !state.get().currentRoom) {
          const roomId = pendingAction.room;
          state.setDmTarget(undefined);
          state.setCurrentRoom(roomId);
        }
        void refreshState();
      }
      pendingAction = undefined;
      break;

    case "error":
      addMessage({ type: "status", text: `Error: ${frame.message}` });
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
  pendingAction = action;
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
  state.clearMessages();

  sendAction({ action: "join_room", room: roomId });

  // Load history
  const messages = await fetchRoomMessages(roomId);
  state.setMessages(messages.map(roomMessageToDisplay));
  addMessage({ type: "system", text: `Joined ${roomId}` });
}

function onSelectAgent(agentId: string): void {
  state.setCurrentRoom(undefined);
  state.setDmTarget(agentId);
  state.clearMessages();
}

function onLeaveRoom(): void {
  const currentRoom = state.get().currentRoom;
  if (currentRoom) {
    sendAction({ action: "leave_room", room: currentRoom });
    state.setCurrentRoom(undefined);
    state.clearMessages();
    addMessage({ type: "system", text: `Left room "${currentRoom}"` });
  }
}

function handleSendAction(text: string): void {
  const s = state.get();
  const result = parseInput(text, s.currentRoom, s.dmTarget);

  switch (result.kind) {
    case "action":
      sendAction(result.action);
      break;
    case "local":
      addMessage({ type: "system", text: result.result.text });
      break;
    case "ignored":
      break;
  }
}

function onCreateRoom(
  name: string,
  type: "public" | "private" | "secret",
  description: string,
): void {
  const action: Action = {
    action: "create_room",
    name,
    type,
    ...(description ? { description } : {}),
  };
  sendAction(action);
}

function onJoinRoomInput(roomName: string): void {
  void onJoinRoom(roomName);
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

function rerender(): void {
  const s = state.get();
  render(
    <App
      rooms={s.rooms}
      agents={s.agents}
      currentRoom={s.currentRoom}
      dmTarget={s.dmTarget}
      messages={s.messages}
      connected={s.connected}
      onJoinRoom={(roomId) => {
        void onJoinRoom(roomId);
      }}
      onSelectAgent={onSelectAgent}
      onLeaveRoom={onLeaveRoom}
      onSendAction={handleSendAction}
      onCreateRoom={onCreateRoom}
      onJoinRoomInput={onJoinRoomInput}
    />,
    rootEl,
  );
}

state.subscribe(rerender);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

ws.connect();
void refreshState();

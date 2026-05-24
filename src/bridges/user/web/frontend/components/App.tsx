/**
 * App — root Preact component.
 *
 * Renders sidebar + chat area. Receives state and action callbacks
 * from the imperative shell in main.tsx.
 */

import type { Agent, DisplayMessage, Room } from "../types.js";
import { ChatArea } from "./ChatArea.js";
import { Sidebar } from "./Sidebar.js";

export interface AppProps {
  rooms: Room[];
  agents: Agent[];
  currentRoom: string | undefined;
  dmTarget: string | undefined;
  messages: DisplayMessage[];
  connected: boolean;
  onJoinRoom: (roomId: string) => void;
  onSelectAgent: (agentId: string) => void;
  onLeaveRoom: () => void;
  onSendAction: (text: string) => void;
  onCreateRoom: (name: string, type: "public" | "private" | "secret", description: string) => void;
  onJoinRoomInput: (roomName: string) => void;
}

export function App(props: AppProps) {
  return (
    <>
      <Sidebar
        rooms={props.rooms}
        agents={props.agents}
        currentRoom={props.currentRoom}
        onJoinRoom={props.onJoinRoom}
        onSelectAgent={props.onSelectAgent}
        onCreateRoom={props.onCreateRoom}
        onJoinRoomInput={props.onJoinRoomInput}
      />
      <ChatArea
        messages={props.messages}
        currentRoom={props.currentRoom}
        dmTarget={props.dmTarget}
        onSendAction={props.onSendAction}
        onLeaveRoom={props.onLeaveRoom}
      />
    </>
  );
}

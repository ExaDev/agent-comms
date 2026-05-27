/**
 * App — root Preact component.
 *
 * Renders sidebar + chat area. Receives state and action callbacks
 * from the imperative shell in main.tsx.
 */

import { useState } from "preact/hooks";
import type { Agent, DisplayMessage, Room } from "../types.js";
import type { RelayStatus } from "../relay-client.js";
import { ChatArea } from "./ChatArea.js";
import { Sidebar } from "./Sidebar.js";

export interface AppProps {
  rooms: Room[];
  agents: Agent[];
  currentRoom: string | undefined;
  dmTarget: string | undefined;
  messages: DisplayMessage[];
  connected: boolean;
  relayStatus: RelayStatus;
  onJoinRoom: (roomId: string) => void;
  onSelectAgent: (agentId: string) => void;
  onRenameAgent: (agentId: string, newName: string) => void;
  onLeaveRoom: () => void;
  onSendAction: (text: string) => void;
  onCreateRoom: (
    name: string,
    type: "public" | "private" | "secret",
    description: string,
  ) => void;
  onJoinRoomInput: (roomName: string) => void;
  onRelayConnect: (urlA: string, urlB: string) => void;
  onRelayDisconnect: () => void;
  onConnectToMesh: () => void;
}

export function App(props: AppProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  return (
    <>
      <button
        id="sidebar-toggle"
        class="sidebar-toggle-btn"
        title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        onClick={() => {
          setSidebarCollapsed((v) => !v);
        }}
      >
        {sidebarCollapsed ? "☰" : "✕"}
      </button>
      <Sidebar
        rooms={props.rooms}
        agents={props.agents}
        currentRoom={props.currentRoom}
        relayStatus={props.relayStatus}
        collapsed={sidebarCollapsed}
        onJoinRoom={props.onJoinRoom}
        onSelectAgent={props.onSelectAgent}
        onRenameAgent={props.onRenameAgent}
        onCreateRoom={props.onCreateRoom}
        onJoinRoomInput={props.onJoinRoomInput}
        onRelayConnect={props.onRelayConnect}
        onRelayDisconnect={props.onRelayDisconnect}
      />
      <ChatArea
        messages={props.messages}
        currentRoom={props.currentRoom}
        dmTarget={props.dmTarget}
        connected={props.connected}
        onSendAction={props.onSendAction}
        onLeaveRoom={props.onLeaveRoom}
        onConnectToMesh={props.onConnectToMesh}
      />
    </>
  );
}

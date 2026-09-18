/**
 * App — root React component.
 *
 * Renders sidebar + chat area inside an AppShell. Receives state and action callbacks from the imperative shell in main.tsx.
 */

import { AppShell, SegmentedControl } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { useState } from "react";
import type { Agent, DisplayMessage, Room } from "../types.js";
import type { MeshClient } from "../mesh-client.js";
import { ChatArea } from "./ChatArea.js";
import { MeshPanel } from "./MeshPanel.js";
import { Sidebar } from "./Sidebar.js";

type MainView = "chat" | "mesh";

export interface AppProps {
  rooms: readonly Room[];
  agents: readonly Agent[];
  currentRoom: string | undefined;
  dmTarget: string | undefined;
  messages: readonly DisplayMessage[];
  connected: boolean;
  queryUtils: MeshClient["queryUtils"];
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
  onConnectToMesh: () => void;
}

export function App(props: AppProps) {
  const [navOpened, { toggle: toggleNav }] = useDisclosure(true);
  const [mainView, setMainView] = useState<MainView>("chat");

  return (
    <AppShell
      navbar={{
        width: 260,
        breakpoint: "sm",
        collapsed: { desktop: !navOpened, mobile: !navOpened },
      }}
    >
      <AppShell.Navbar>
        <Sidebar
          rooms={props.rooms}
          agents={props.agents}
          currentRoom={props.currentRoom}
          onJoinRoom={props.onJoinRoom}
          onSelectAgent={props.onSelectAgent}
          onRenameAgent={props.onRenameAgent}
          onCreateRoom={props.onCreateRoom}
          onJoinRoomInput={props.onJoinRoomInput}
        />
        <SegmentedControl
          m="xs"
          size="xs"
          fullWidth
          value={mainView}
          onChange={setMainView}
          data={[
            { label: "Chat", value: "chat" },
            { label: "Mesh", value: "mesh" },
          ]}
        />
      </AppShell.Navbar>
      <AppShell.Main h="100vh">
        {mainView === "chat" ? (
          <ChatArea
            messages={props.messages}
            rooms={props.rooms}
            currentRoom={props.currentRoom}
            dmTarget={props.dmTarget}
            connected={props.connected}
            sidebarOpened={navOpened}
            onToggleSidebar={toggleNav}
            onSendAction={props.onSendAction}
            onLeaveRoom={props.onLeaveRoom}
            onConnectToMesh={props.onConnectToMesh}
          />
        ) : (
          <MeshPanel queryUtils={props.queryUtils} />
        )}
      </AppShell.Main>
    </AppShell>
  );
}

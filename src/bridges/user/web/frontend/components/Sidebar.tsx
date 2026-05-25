/**
 * Sidebar — project tree, manual rooms, create/join room controls.
 */

import { useState } from "preact/hooks";
import type { Agent, Room } from "../types.js";
import { buildProjectTree } from "../project-tree.js";
import { CreateRoomForm } from "./CreateRoomForm.js";
import { JoinForm } from "./JoinForm.js";
import { ProjectTree } from "./ProjectTree.js";

interface SidebarProps {
  rooms: Room[];
  agents: Agent[];
  currentRoom: string | undefined;
  onJoinRoom: (roomId: string) => void;
  onSelectAgent: (agentId: string) => void;
  onRenameAgent: (agentId: string, newName: string) => void;
  onCreateRoom: (
    name: string,
    type: "public" | "private" | "secret",
    description: string,
  ) => void;
  onJoinRoomInput: (roomName: string) => void;
}

export function Sidebar({
  rooms,
  agents,
  currentRoom,
  onJoinRoom,
  onSelectAgent,
  onRenameAgent,
  onCreateRoom,
  onJoinRoomInput,
}: SidebarProps) {
  const [createFormVisible, setCreateFormVisible] = useState(false);
  const [joinFormVisible, setJoinFormVisible] = useState(false);
  const [showOffline, setShowOffline] = useState(false);
  const visibleAgents = showOffline
    ? agents
    : agents.filter((a) => a.status !== "offline");
  const tree = buildProjectTree(visibleAgents, rooms);

  return (
    <div id="sidebar">
      <h2>
        Agent Comms
        <button
          id="toggle-offline-btn"
          class={`icon-btn${showOffline ? " active" : ""}`}
          title={`${showOffline ? "Hide" : "Show"} offline agents`}
          onClick={() => setShowOffline((v) => !v)}
        >
          {showOffline ? "◉" : "◎"}
        </button>
      </h2>
      <div class="sidebar-section">
        <ProjectTree
          tree={tree}
          onJoinRoom={onJoinRoom}
          onSelectAgent={onSelectAgent}
          onRenameAgent={onRenameAgent}
          currentRoom={currentRoom}
        />
        <div class="section-heading">
          <h3>Create</h3>
          <button
            id="create-room-toggle"
            class="icon-btn"
            title="Create room"
            onClick={() => {
              setCreateFormVisible((v) => !v);
            }}
          >
            +
          </button>
        </div>
        <CreateRoomForm
          visible={createFormVisible}
          onSubmit={(name, type, desc) => {
            onCreateRoom(name, type, desc);
            setCreateFormVisible(false);
          }}
          onCancel={() => {
            setCreateFormVisible(false);
          }}
        />
        <button
          id="join-toggle-btn"
          class="join-toggle-btn"
          onClick={() => {
            setJoinFormVisible((v) => !v);
          }}
        >
          + Join Room
        </button>
        <JoinForm
          visible={joinFormVisible}
          onSubmit={(name) => {
            onJoinRoomInput(name);
            setJoinFormVisible(false);
          }}
          onCancel={() => {
            setJoinFormVisible(false);
          }}
        />
      </div>
    </div>
  );
}

/**
 * Sidebar — rooms list, agents list, create/join room controls.
 */

import { useState } from "preact/hooks";
import type { Agent, Room } from "../types.js";
import { CreateRoomForm } from "./CreateRoomForm.js";
import { JoinForm } from "./JoinForm.js";

interface SidebarProps {
  rooms: Room[];
  agents: Agent[];
  currentRoom: string | undefined;
  onJoinRoom: (roomId: string) => void;
  onSelectAgent: (agentId: string) => void;
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
  onCreateRoom,
  onJoinRoomInput,
}: SidebarProps) {
  const [createFormVisible, setCreateFormVisible] = useState(false);
  const [joinFormVisible, setJoinFormVisible] = useState(false);

  return (
    <div id="sidebar">
      <h2>Agent Comms</h2>
      <div class="sidebar-section">
        <div class="section-heading">
          <h3>Rooms</h3>
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
        <div id="room-list">
          {rooms.map((room) => (
            <div
              key={room.id}
              class={`room-item${currentRoom === room.id ? " active" : ""}`}
              onClick={() => {
                onJoinRoom(room.id);
              }}
            >
              {room.type.charAt(0).toUpperCase()} {room.name}{" "}
              <span style="color:var(--dim)">
                ({String(room.members.length)})
              </span>
            </div>
          ))}
        </div>
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
        <h3>Agents</h3>
        <div id="agent-list">
          {agents.map((agent) => (
            <div
              key={agent.id}
              class="agent-item"
              onClick={() => {
                onSelectAgent(agent.id);
              }}
            >
              <span class={`status-dot ${agent.status}`} />
              {` ${agent.name}`}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Client-side types for the agent-comms web UI.
 *
 * These mirror the wire format from server.ts and core/types.ts.
 * No Zod — just interfaces for the browser bundle.
 */

// ---------------------------------------------------------------------------
// Agent & Room
// ---------------------------------------------------------------------------

export interface Agent {
  id: string;
  name: string;
  harness: string;
  cwd: string;
  pid: number;
  startedAt: string;
  visibility: "visible" | "hidden" | "ghost";
  status: "active" | "idle" | "busy" | "offline";
  tags: string[];
  subscribedRooms: string[];
}

export interface Room {
  id: string;
  name: string;
  type: "public" | "private" | "secret";
  owner: string;
  createdAt: string;
  description: string;
  members: string[];
  invited: string[];
}

export interface RoomMessage {
  id: string;
  from: string;
  room: string;
  content: string;
  timestamp: string;
  replyTo?: string;
  readBy: string[];
}

export interface DmMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  timestamp: string;
  readBy: string[];
}

export interface RoomMember {
  id: string;
  name: string;
  status: Agent["status"];
}

// ---------------------------------------------------------------------------
// Delivery events (server → client over WebSocket)
// ---------------------------------------------------------------------------

export type DeliveryEvent =
  | { type: "room_message"; message: RoomMessage }
  | { type: "dm"; message: DmMessage }
  | {
      type: "room_invite";
      room: string;
      roomDescription: string;
      from: string;
      fromName: string;
      fromCwd: string;
    }
  | { type: "member_joined"; room: string; agent: string }
  | { type: "member_left"; room: string; agent: string }
  | { type: "room_members"; room: string; members: RoomMember[] }
  | { type: "member_status"; room: string; agent: string; status: Agent["status"] }
  | {
      type: "delivery_status";
      messageId: string;
      agent: string;
      status: "delivered" | "read";
      room?: string;
    }
  | {
      type: "invite_declined";
      room: string;
      agent: string;
      agentName: string;
      reason: string;
    }
  | {
      type: "name_changed";
      agent: string;
      oldName: string;
      newName: string;
    };

// ---------------------------------------------------------------------------
// WebSocket frames (server → client)
// ---------------------------------------------------------------------------

export type WsFrame =
  | { type: "delivery"; event: DeliveryEvent }
  | { type: "result"; result: ActionResult }
  | { type: "error"; message: string }
  | { type: "state"; agents: Agent[]; rooms: Room[] };

// ---------------------------------------------------------------------------
// Actions (client → server)
// ---------------------------------------------------------------------------

export type Action =
  | { action: "send"; target: string; content: string }
  | { action: "dm"; target: string; content: string }
  | { action: "join_room"; room: string }
  | { action: "leave_room"; room: string }
  | { action: "create_room"; name: string; type: "public" | "private" | "secret"; description?: string }
  | { action: "list_rooms" }
  | { action: "list_agents" }
  | { action: "read_room"; room: string }
  | { action: "destroy_room"; room: string }
  | { action: "invite"; room: string; agent: string }
  | { action: "decline_invite"; room: string; reason: string }
  | { action: "kick"; room: string; agent: string }
  | { action: "rename_agent"; agent: string; name: string };

export interface ActionResult {
  content: string;
  isError: boolean;
}

// ---------------------------------------------------------------------------
// Display messages (client-side message store)
// ---------------------------------------------------------------------------

export type DisplayMessage =
  | { type: "chat"; sender: string; content: string; timestamp: string }
  | { type: "dm"; sender: string; content: string; timestamp: string }
  | { type: "system"; text: string }
  | { type: "status"; text: string };

// ---------------------------------------------------------------------------
// REST API responses
// ---------------------------------------------------------------------------

export type AgentsResponse = Agent[];
export type RoomsResponse = Room[];
export type MessagesResponse = RoomMessage[];

// ---------------------------------------------------------------------------
// Project tree (sidebar directory tree)
// ---------------------------------------------------------------------------

/** A directory node in the project tree. Contains child directories and agents. */
export interface DirectoryNode {
  type: "directory";
  /** Directory basename (e.g. "agent-comms") */
  name: string;
  /** Full absolute path */
  path: string;
  /** Project room ID if a room exists for this directory */
  roomId?: string;
  children: TreeNode[];
}

/** An agent leaf node in the project tree. */
export interface AgentNode {
  type: "agent";
  name: string;
  agentId: string;
  status: Agent["status"];
  cwd: string;
}

export type TreeNode = DirectoryNode | AgentNode;

/** The full project tree with manually-created rooms separated out. */
export interface ProjectTree {
  roots: TreeNode[];
  /** Rooms not auto-created per cwd */
  manualRooms: Room[];
}


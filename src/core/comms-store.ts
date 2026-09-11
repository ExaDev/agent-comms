/**
 * CommsStore — abstract interface for the agent communication store.
 *
 * Two implementations: FileStore — filesystem-backed, no server process (fallback) MeshStore — TCP peer mesh, in-memory, real-time push (preferred)
 *
 * Bridges depend on this interface, not on a specific implementation.
 *
 * Deliberately excludes listener management, federation, and connection approval: those are transport concerns MeshStore alone can support -- FileStore has no network transport to manage listeners on, federate through, or approve inbound connections for. Widening this interface to cover them (as it once did, via always-throwing FileStore stubs) is what forced server.ts and the bridge controller to reach past CommsStore into the concrete MeshStore anyway; CommsTool, the one consumer that genuinely needs to expose these when a MeshStore backs it, takes them as an optional extension (see MeshOnlyFeatures in tool.ts) rather than the shared interface pretending every implementation supports them.
 */

import type {
  AgentIdentity,
  DeliveryEvent,
  DmMessage,
  Room,
  RoomMessage,
  RoomType,
  StreamingBehavior,
  Visibility,
} from "./types.js";

export interface CommsStore {
  // -- Identity --
  readIdentity(
    harness: string,
    cwd: string,
  ): Promise<{ id: string } | undefined>;
  writeIdentity(harness: string, cwd: string, id: string): Promise<void>;

  // -- Agent registry --
  registerAgent(opts: {
    name: string;
    harness: string;
    cwd: string;
    pid: number;
    visibility: Visibility;
    tags: string[];
  }): Promise<AgentIdentity>;
  getAgent(id: string): Promise<AgentIdentity | undefined>;
  updateAgent(
    id: string,
    patch: Partial<
      Pick<AgentIdentity, "name" | "visibility" | "status" | "tags" | "pid">
    >,
  ): Promise<AgentIdentity>;
  listAgents(requesterId: string): Promise<AgentIdentity[]>;
  setAgentOffline(id: string): Promise<void>;

  // -- Rooms --
  createRoom(opts: {
    name: string;
    type: RoomType;
    owner: string;
    description: string;
  }): Promise<Room>;
  getRoom(id: string): Promise<Room | undefined>;
  listRooms(requesterId: string): Promise<Room[]>;
  joinRoom(roomId: string, agentId: string): Promise<Room>;
  leaveRoom(roomId: string, agentId: string): Promise<void>;
  inviteToRoom(
    roomId: string,
    targetId: string,
    inviterId: string,
  ): Promise<void>;
  declineInvite(roomId: string, agentId: string, reason: string): Promise<void>;
  kickFromRoom(
    roomId: string,
    targetId: string,
    kickerId: string,
  ): Promise<void>;
  destroyRoom(roomId: string, agentId: string): Promise<void>;

  // -- Messages --
  sendRoomMessage(
    roomId: string,
    from: string,
    content: string,
    replyTo?: string,
    streamingBehavior?: StreamingBehavior,
  ): Promise<RoomMessage>;
  readRoomMessages(roomId: string, since?: string): Promise<RoomMessage[]>;

  // -- DMs --
  sendDm(
    from: string,
    to: string,
    content: string,
    streamingBehavior?: StreamingBehavior,
  ): Promise<DmMessage>;

  // -- Delivery --
  deliver(agentId: string, event: DeliveryEvent): Promise<void>;
  drainDelivery(agentId: string): Promise<DeliveryEvent[]>;

  // -- Lifecycle --
  init(): Promise<void>;
}

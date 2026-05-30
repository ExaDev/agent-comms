/**
 * CommsStore — abstract interface for the agent communication store.
 *
 * Two implementations:
 *   FileStore — filesystem-backed, no server process (fallback)
 *   MeshStore — TCP peer mesh, in-memory, real-time push (preferred)
 *
 * Bridges depend on this interface, not on a specific implementation.
 */

import type {
  AgentIdentity,
  DeliveryEvent,
  DmMessage,
  NetworkInterface,
  Room,
  RoomMessage,
  RoomType,
  StreamingBehavior,
  Visibility,
} from "./types.js";
import type { ListenerInfo } from "./transport.js";
import type { FedLink } from "./federation.js";

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

  // -- Listener management (coordinator only) --
  addListener(host: string, port: number, policy: string): Promise<string>;
  removeListener(id: string): Promise<void>;
  listListeners(): ListenerInfo[];
  getNetworkInterfaces(): NetworkInterface[];

  // -- Federation (coordinator-to-coordinator) --
  fedConnect(host: string, port: number, name?: string): Promise<string>;
  fedDisconnect(linkId: string): Promise<void>;
  fedLinks(): FedLink[];
  // -- Connection approval --
  acceptConnection(connectionId: string): Promise<void>;
  rejectConnection(connectionId: string, reason: string): Promise<void>;
  listPendingConnections(): {
    connectionId: string;
    peerId: string;
    dataPort: number;
    name: string;
    fingerprint: string;
  }[];
  connectToRemote(host: string, port: number): Promise<void>;

  /** Start only the data server without connecting to a coordinator. */
  startDataServerOnly(): Promise<void>;

  // -- Lifecycle --
  init(): Promise<void>;
}

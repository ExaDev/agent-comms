/**
 * ChatController — shared logic for user-facing UIs (TUI, web, CLI).
 *
 * Wraps MeshStore + CommsTool with an EventEmitter interface.
 * UIs subscribe to events and call methods — no direct MeshStore access needed.
 */

import { EventEmitter } from "node:events";
import {
  MeshStore,
  CommsTool,
  ensureRegistered,
  formatDeliveryEvent,
} from "../../core/index.js";
import { TlsTransport } from "../../core/tls-transport.js";
import { generateIdentity } from "../../core/identity.js";
import type { CommsContext, CommsResult } from "../../core/tool.js";
import type {
  AgentIdentity,
  DeliveryEvent,
  Room,
  RoomMessage,
} from "../../core/types.js";

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export class ChatController extends EventEmitter {
  private store: MeshStore;

  /** Expose the underlying MeshStore for handle cleanup. */
  get meshStore(): MeshStore {
    return this.store;
  }
  private tool: CommsTool;
  private ctx!: CommsContext;
  private currentRoom: string | undefined;

  constructor(private userName: string) {
    super();
    const identity = generateIdentity();
    this.store = new MeshStore();
    this.store.peerId = identity.fingerprint;
    this.store.setTransport(new TlsTransport(this.store.events, identity));
    this.tool = new CommsTool(this.store, this.store.discovery);

    // Push delivery events to UIs
    this.store.onDelivery = (_agentId: string, event: DeliveryEvent) => {
      this.emit("message", event);
    };
  }

  /**
   * Create a ChatController wrapping an existing MeshStore and identity.
   *
   * Used by bridges that already have a store and agent registration
   * (e.g. pi, Claude Code) so the web UI shares the same mesh peer
   * instead of creating a redundant one.
   */
  static fromExisting(store: MeshStore, ctx: CommsContext): ChatController {
    const ctrl = Object.create(ChatController.prototype) as ChatController;
    EventEmitter.call(ctrl);
    ctrl.store = store;
    ctrl.tool = new CommsTool(store, store.discovery);
    ctrl.ctx = ctx;
    ctrl.currentRoom = undefined;
    ctrl.userName = "";

    // Push delivery events to UIs
    store.onDelivery = (_agentId: string, event: DeliveryEvent) => {
      ctrl.emit("message", event);
    };

    return ctrl;
  }

  async init(): Promise<void> {
    await this.store.init();

    const reg = await ensureRegistered({
      store: this.store,
      cwd: process.cwd(),
      harness: "user",
      defaultName: `${this.userName} (user)`,
      visibility: "visible",
      tags: ["user"],
    });

    this.ctx = {
      agentId: reg.agentId,
      harness: "user",
      cwd: process.cwd(),
      pid: process.pid,
    };
  }

  get agentId(): string {
    return this.ctx.agentId;
  }

  get activeRoom(): string | undefined {
    return this.currentRoom;
  }

  // -----------------------------------------------------------------------
  // Actions
  // -----------------------------------------------------------------------

  async listAgents(): Promise<CommsResult> {
    return this.tool.handle(this.ctx, { action: "list_agents" });
  }

  async listRooms(): Promise<CommsResult> {
    return this.tool.handle(this.ctx, { action: "list_rooms" });
  }

  async createRoom(
    name: string,
    type: "public" | "private" | "secret" = "public",
    description = "",
  ): Promise<CommsResult> {
    const result = await this.tool.handle(this.ctx, {
      action: "create_room",
      name,
      type,
      description,
    });
    // Auto-switch to the created room
    this.currentRoom = name;
    return result;
  }

  async joinRoom(roomId: string): Promise<CommsResult> {
    const result = await this.tool.handle(this.ctx, {
      action: "join_room",
      room: roomId,
    });
    this.currentRoom = roomId;
    return result;
  }

  async leaveRoom(roomId?: string): Promise<CommsResult> {
    const target = roomId ?? this.currentRoom;
    if (!target) {
      return { content: "No room to leave. Join a room first.", isError: true };
    }
    const result = await this.tool.handle(this.ctx, {
      action: "leave_room",
      room: target,
    });
    if (this.currentRoom === target) {
      this.currentRoom = undefined;
    }
    return result;
  }

  async send(target: string, content: string): Promise<CommsResult> {
    return this.tool.handle(this.ctx, { action: "send", target, content });
  }

  async sendToCurrentRoom(content: string): Promise<CommsResult> {
    if (!this.currentRoom) {
      return { content: "No active room. Join a room first.", isError: true };
    }
    return this.send(this.currentRoom, content);
  }

  async dm(targetAgentId: string, content: string): Promise<CommsResult> {
    return this.tool.handle(this.ctx, {
      action: "dm",
      target: targetAgentId,
      content,
    });
  }

  async readRoom(roomId?: string, since?: string): Promise<CommsResult> {
    const target = roomId ?? this.currentRoom;
    if (!target) {
      return { content: "No room to read. Join a room first.", isError: true };
    }
    return this.tool.handle(this.ctx, {
      action: "read_room",
      room: target,
      ...(since && { since }),
    });
  }

  async invite(roomId: string, agentId: string): Promise<CommsResult> {
    return this.tool.handle(this.ctx, {
      action: "invite",
      room: roomId,
      agent: agentId,
    });
  }

  async declineInvite(roomId: string, reason: string): Promise<CommsResult> {
    return this.tool.handle(this.ctx, {
      action: "decline_invite",
      room: roomId,
      reason,
    });
  }

  async kick(roomId: string, agentId: string): Promise<CommsResult> {
    return this.tool.handle(this.ctx, {
      action: "kick",
      room: roomId,
      agent: agentId,
    });
  }

  async renameAgent(agentId: string, newName: string): Promise<CommsResult> {
    const agent = await this.store.getAgent(agentId);
    if (!agent) {
      return { content: `Agent ${agentId} not found.`, isError: true };
    }
    const oldName = agent.name;
    await this.store.updateAgent(agentId, { name: newName });
    return {
      content: `Renamed ${oldName} to ${newName}.`,
      isError: false,
    };
  }

  async destroyRoom(roomId: string): Promise<CommsResult> {
    const result = await this.tool.handle(this.ctx, {
      action: "destroy_room",
      room: roomId,
    });
    if (this.currentRoom === roomId) {
      this.currentRoom = undefined;
    }
    return result;
  }

  async switchRoom(roomId: string): Promise<CommsResult> {
    // Check if already a member — if not, join first
    const rooms = await this.store.listRooms(this.ctx.agentId);
    const room = rooms.find((r) => r.id === roomId || r.name === roomId);
    if (!room) {
      return { content: `Room "${roomId}" not found.`, isError: true };
    }

    if (!room.members.includes(this.ctx.agentId)) {
      const result = await this.joinRoom(room.id);
      if (result.isError) return result;
    }

    this.currentRoom = room.id;
    return {
      content: `Switched to ${room.name}.`,
      isError: false,
    };
  }

  // -----------------------------------------------------------------------
  // Raw access for web API
  // -----------------------------------------------------------------------

  async getAgents(): Promise<AgentIdentity[]> {
    return this.store.listAgents(this.ctx.agentId);
  }

  async getRooms(): Promise<Room[]> {
    return this.store.listRooms(this.ctx.agentId);
  }

  async getRoomMessages(
    roomId: string,
    since?: string,
  ): Promise<RoomMessage[]> {
    return this.store.readRoomMessages(roomId, since);
  }

  formatEvent(event: DeliveryEvent): string {
    return formatDeliveryEvent(event);
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async shutdown(): Promise<void> {
    if (this.ctx) {
      await this.store.setAgentOffline(this.ctx.agentId);
    }
    await this.store.shutdown();
  }
}

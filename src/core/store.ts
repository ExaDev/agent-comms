/**
 * Filesystem layout for agent comms.
 *
 * All paths are relative to a configurable comms root (default: ~/.agents/comms/).
 * Every operation is a file read/write — no server process needed.
 * JSON.parse boundaries use Zod schemas for type-safe parsing.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { nanoid } from "./nanoid.js";

/** Swallow expected filesystem errors (e.g. file already deleted). */
function swallow(_error: unknown): void {
  /* intentionally empty — expected failure */
}

import {
  AgentIdentitySchema,
  DeliveryEventSchema,
  RoomMessageSchema,
  RoomSchema,
} from "./types.js";
import type {
  AgentIdentity,
  DeliveryEvent,
  DmMessage,
  Room,
  RoomMessage,
  RoomType,
  Visibility,
} from "./types.js";
import type { CommsStore } from "./comms-store.js";

// ---------------------------------------------------------------------------
// CommsError
// ---------------------------------------------------------------------------

export class CommsError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "CommsError";
  }
}

// ---------------------------------------------------------------------------
// FileStore
// ---------------------------------------------------------------------------

export class FileStore implements CommsStore {
  constructor(
    public readonly root: string = path.join(os.homedir(), ".agents", "comms"),
  ) {}

  // -------------------------------------------------------------------------
  // Paths
  // -------------------------------------------------------------------------

  agentPath(id: string): string {
    return path.join(this.root, "registry", "agents", `${id}.json`);
  }

  roomPath(id: string): string {
    return path.join(this.root, "registry", "rooms", `${id}.json`);
  }

  roomMessagesDir(id: string): string {
    return path.join(this.root, "rooms", id);
  }

  dmDir(a: string, b: string): string {
    const sorted = [a, b].sort();
    const first = sorted[0] ?? a;
    const second = sorted[1] ?? b;
    return path.join(this.root, "dms", `${first}--${second}`);
  }

  deliveryDir(id: string): string {
    return path.join(this.root, "delivery", id);
  }

  identityPath(harness: string, cwd: string): string {
    const slug = cwd.replace(/[^a-zA-Z0-9]/g, "_");
    return path.join(this.root, "identity", `${harness}--${slug}.json`);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async readJsonFile(filePath: string): Promise<unknown> {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw);
  }

  private async writeJsonFile(filePath: string, data: unknown): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  }

  // -------------------------------------------------------------------------
  // Identity
  // -------------------------------------------------------------------------

  async readIdentity(
    harness: string,
    cwd: string,
  ): Promise<{ id: string } | undefined> {
    try {
      const raw = await this.readJsonFile(this.identityPath(harness, cwd));
      if (typeof raw === "object" && raw !== null && "id" in raw) {
        const id = raw.id;
        if (typeof id === "string") return { id };
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  async writeIdentity(harness: string, cwd: string, id: string): Promise<void> {
    await this.writeJsonFile(this.identityPath(harness, cwd), { id });
  }

  // -------------------------------------------------------------------------
  // Agent registry
  // -------------------------------------------------------------------------

  async registerAgent(opts: {
    name: string;
    harness: string;
    cwd: string;
    pid: number;
    visibility: Visibility;
    tags: string[];
  }): Promise<AgentIdentity> {
    const existing = await this.readIdentity(opts.harness, opts.cwd);
    if (existing) {
      return this.updateAgent(existing.id, {
        name: opts.name,
        visibility: opts.visibility,
        tags: opts.tags,
        status: "active",
        pid: opts.pid,
      });
    }

    const id = nanoid(8);
    const agent: AgentIdentity = {
      id,
      name: opts.name,
      harness: opts.harness,
      cwd: opts.cwd,
      pid: opts.pid,
      startedAt: new Date().toISOString(),
      visibility: opts.visibility,
      status: "active",
      tags: opts.tags,
      subscribedRooms: [],
    };

    await this.writeJsonFile(this.agentPath(id), agent);
    await this.writeIdentity(opts.harness, opts.cwd, id);
    return agent;
  }

  async getAgent(id: string): Promise<AgentIdentity | undefined> {
    try {
      return AgentIdentitySchema.parse(
        await this.readJsonFile(this.agentPath(id)),
      );
    } catch {
      return undefined;
    }
  }

  async updateAgent(
    id: string,
    patch: Partial<
      Pick<AgentIdentity, "name" | "visibility" | "status" | "tags" | "pid">
    >,
  ): Promise<AgentIdentity> {
    const agent = await this.getAgent(id);
    if (!agent)
      throw new CommsError(`Agent ${id} not found`, "AGENT_NOT_FOUND");

    Object.assign(agent, patch);
    await this.writeJsonFile(this.agentPath(id), agent);
    return agent;
  }

  async listAgents(requesterId: string): Promise<AgentIdentity[]> {
    const dir = path.join(this.root, "registry", "agents");
    try {
      const files = await fs.readdir(dir);
      const agents: AgentIdentity[] = [];
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const agent = AgentIdentitySchema.parse(
          await this.readJsonFile(path.join(dir, file)),
        );
        if (agent.visibility === "ghost" && agent.id !== requesterId) continue;
        agents.push(agent);
      }
      return agents;
    } catch {
      return [];
    }
  }

  async setAgentOffline(id: string): Promise<void> {
    const agent = await this.getAgent(id);
    if (agent) {
      agent.status = "offline";
      await this.writeJsonFile(this.agentPath(id), agent);
    }
  }

  // -------------------------------------------------------------------------
  // Rooms
  // -------------------------------------------------------------------------

  async createRoom(opts: {
    name: string;
    type: RoomType;
    owner: string;
    description: string;
  }): Promise<Room> {
    const id = opts.type === "secret" ? `_${opts.name}` : opts.name;
    const existing = await this.getRoom(id);
    if (existing)
      throw new CommsError(`Room ${id} already exists`, "ROOM_EXISTS");

    const room: Room = {
      id,
      name: opts.name,
      type: opts.type,
      owner: opts.owner,
      createdAt: new Date().toISOString(),
      description: opts.description,
      members: [opts.owner],
      invited: [],
    };

    await this.writeJsonFile(this.roomPath(id), room);
    await fs.mkdir(this.roomMessagesDir(id), { recursive: true });
    return room;
  }

  async getRoom(id: string): Promise<Room | undefined> {
    try {
      return RoomSchema.parse(await this.readJsonFile(this.roomPath(id)));
    } catch {
      return undefined;
    }
  }

  async listRooms(requesterId: string): Promise<Room[]> {
    const dir = path.join(this.root, "registry", "rooms");
    try {
      const files = await fs.readdir(dir);
      const rooms: Room[] = [];
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const room = RoomSchema.parse(
          await this.readJsonFile(path.join(dir, file)),
        );
        if (room.type === "secret" && !room.members.includes(requesterId))
          continue;
        rooms.push(room);
      }
      return rooms;
    } catch {
      return [];
    }
  }

  async joinRoom(roomId: string, agentId: string): Promise<Room> {
    const room = await this.getRoom(roomId);
    if (!room)
      throw new CommsError(`Room ${roomId} not found`, "ROOM_NOT_FOUND");

    if (room.type === "public") {
      if (!room.members.includes(agentId)) {
        room.members.push(agentId);
      }
    } else {
      if (
        !room.invited.includes(agentId) &&
        room.owner !== agentId &&
        !room.members.includes(agentId)
      ) {
        throw new CommsError(`Not invited to room ${roomId}`, "NOT_INVITED");
      }
      room.invited = room.invited.filter((id) => id !== agentId);
      if (!room.members.includes(agentId)) {
        room.members.push(agentId);
      }
    }

    await this.writeJsonFile(this.roomPath(roomId), room);

    const agent = await this.getAgent(agentId);
    if (agent && !agent.subscribedRooms.includes(roomId)) {
      agent.subscribedRooms.push(roomId);
      await this.writeJsonFile(this.agentPath(agentId), agent);
    }

    await this.deliverToMembers(
      roomId,
      { type: "member_joined", room: roomId, agent: agentId },
      agentId,
    );

    return room;
  }

  async leaveRoom(roomId: string, agentId: string): Promise<void> {
    const room = await this.getRoom(roomId);
    if (!room)
      throw new CommsError(`Room ${roomId} not found`, "ROOM_NOT_FOUND");

    room.members = room.members.filter((id) => id !== agentId);
    await this.writeJsonFile(this.roomPath(roomId), room);

    const agent = await this.getAgent(agentId);
    if (agent) {
      agent.subscribedRooms = agent.subscribedRooms.filter(
        (id) => id !== roomId,
      );
      await this.writeJsonFile(this.agentPath(agentId), agent);
    }

    await this.deliverToMembers(
      roomId,
      { type: "member_left", room: roomId, agent: agentId },
      agentId,
    );

    if (room.members.length === 0 && room.owner === agentId) {
      await this.destroyRoom(roomId, agentId);
    }
  }

  async inviteToRoom(
    roomId: string,
    targetId: string,
    inviterId: string,
  ): Promise<void> {
    const room = await this.getRoom(roomId);
    if (!room)
      throw new CommsError(`Room ${roomId} not found`, "ROOM_NOT_FOUND");
    if (room.owner !== inviterId)
      throw new CommsError("Only the room owner can invite", "NOT_OWNER");

    if (!room.invited.includes(targetId) && !room.members.includes(targetId)) {
      room.invited.push(targetId);
    }
    await this.writeJsonFile(this.roomPath(roomId), room);

    const inviter = await this.getAgent(inviterId);
    await this.deliver(targetId, {
      type: "room_invite",
      room: roomId,
      roomDescription: room.description,
      from: inviterId,
      fromName: inviter?.name ?? inviterId,
      fromCwd: inviter?.cwd ?? "",
    });
  }

  async declineInvite(
    roomId: string,
    agentId: string,
    reason: string,
  ): Promise<void> {
    const room = await this.getRoom(roomId);
    if (!room)
      throw new CommsError(`Room ${roomId} not found`, "ROOM_NOT_FOUND");

    if (!room.invited.includes(agentId))
      throw new CommsError(
        `Agent ${agentId} was not invited to ${roomId}`,
        "NOT_INVITED",
      );

    room.invited = room.invited.filter((id) => id !== agentId);
    await this.writeJsonFile(this.roomPath(roomId), room);

    const decliner = await this.getAgent(agentId);
    await this.deliver(room.owner, {
      type: "invite_declined",
      room: roomId,
      agent: agentId,
      agentName: decliner?.name ?? agentId,
      reason,
    });
  }

  async kickFromRoom(
    roomId: string,
    targetId: string,
    kickerId: string,
  ): Promise<void> {
    const room = await this.getRoom(roomId);
    if (!room)
      throw new CommsError(`Room ${roomId} not found`, "ROOM_NOT_FOUND");
    if (room.owner !== kickerId)
      throw new CommsError("Only the room owner can kick", "NOT_OWNER");

    room.members = room.members.filter((id) => id !== targetId);
    room.invited = room.invited.filter((id) => id !== targetId);
    await this.writeJsonFile(this.roomPath(roomId), room);
  }

  async destroyRoom(roomId: string, agentId: string): Promise<void> {
    const room = await this.getRoom(roomId);
    if (!room)
      throw new CommsError(`Room ${roomId} not found`, "ROOM_NOT_FOUND");
    if (room.owner !== agentId)
      throw new CommsError("Only the room owner can destroy", "NOT_OWNER");

    for (const memberId of room.members) {
      const member = await this.getAgent(memberId);
      if (member) {
        member.subscribedRooms = member.subscribedRooms.filter(
          (id) => id !== roomId,
        );
        await this.writeJsonFile(this.agentPath(memberId), member);
      }
    }

    await fs.unlink(this.roomPath(roomId)).catch(swallow);
    await fs
      .rm(this.roomMessagesDir(roomId), { recursive: true })
      .catch(swallow);
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  async sendRoomMessage(
    roomId: string,
    from: string,
    content: string,
    replyTo?: string,
  ): Promise<RoomMessage> {
    const room = await this.getRoom(roomId);
    if (!room)
      throw new CommsError(`Room ${roomId} not found`, "ROOM_NOT_FOUND");
    if (!room.members.includes(from))
      throw new CommsError(`Not a member of ${roomId}`, "NOT_MEMBER");

    const id = `${String(Date.now())}-${nanoid(6)}`;
    const message: RoomMessage = {
      id,
      from,
      room: roomId,
      content,
      timestamp: new Date().toISOString(),
      replyTo,
      readBy: [from],
    };

    await fs.mkdir(this.roomMessagesDir(roomId), { recursive: true });
    await this.writeJsonFile(
      path.join(this.roomMessagesDir(roomId), `${id}.json`),
      message,
    );

    await this.deliverToMembers(
      roomId,
      { type: "room_message", message },
      from,
    );

    return message;
  }

  async readRoomMessages(
    roomId: string,
    since?: string,
  ): Promise<RoomMessage[]> {
    const dir = this.roomMessagesDir(roomId);
    try {
      const files = await fs.readdir(dir);
      const messages: RoomMessage[] = [];
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const msg = RoomMessageSchema.parse(
          await this.readJsonFile(path.join(dir, file)),
        );
        if (!since || msg.timestamp > since) {
          messages.push(msg);
        }
      }
      messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      return messages;
    } catch {
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // DMs
  // -------------------------------------------------------------------------

  async sendDm(from: string, to: string, content: string): Promise<DmMessage> {
    if (to !== from) {
      const recipient = await this.getAgent(to);
      if (!recipient)
        throw new CommsError(`Agent ${to} not found`, "AGENT_NOT_FOUND");
      if (recipient.visibility === "ghost")
        throw new CommsError(`Cannot DM agent ${to}`, "AGENT_NOT_FOUND");
    }

    const id = `${String(Date.now())}-${nanoid(6)}`;
    const message: DmMessage = {
      id,
      from,
      to,
      content,
      timestamp: new Date().toISOString(),
      readBy: [from],
    };

    const dir = this.dmDir(from, to);
    await fs.mkdir(dir, { recursive: true });
    await this.writeJsonFile(path.join(dir, `${id}.json`), message);

    await this.deliver(to, { type: "dm", message });

    return message;
  }

  // -------------------------------------------------------------------------
  // Delivery
  // -------------------------------------------------------------------------

  async deliver(agentId: string, event: DeliveryEvent): Promise<void> {
    const dir = this.deliveryDir(agentId);
    await fs.mkdir(dir, { recursive: true });
    const id = `${String(Date.now())}-${nanoid(6)}`;
    await this.writeJsonFile(path.join(dir, `${id}.json`), event);
  }

  async drainDelivery(agentId: string): Promise<DeliveryEvent[]> {
    const dir = this.deliveryDir(agentId);
    try {
      const files = await fs.readdir(dir);
      const events: DeliveryEvent[] = [];
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const event = DeliveryEventSchema.parse(
          await this.readJsonFile(path.join(dir, file)),
        );
        events.push(event);
        await fs.unlink(path.join(dir, file));
      }
      events.sort((a, b) => {
        const ta =
          a.type === "room_message" || a.type === "dm"
            ? a.message.timestamp
            : "";
        const tb =
          b.type === "room_message" || b.type === "dm"
            ? b.message.timestamp
            : "";
        return ta.localeCompare(tb);
      });
      return events;
    } catch {
      return [];
    }
  }

  private async deliverToMembers(
    roomId: string,
    event: DeliveryEvent,
    excludeAgent: string,
  ): Promise<void> {
    const room = await this.getRoom(roomId);
    if (!room) return;

    for (const memberId of room.members) {
      if (memberId !== excludeAgent) {
        await this.deliver(memberId, event);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Comms initialisation
  // -------------------------------------------------------------------------

  async init(): Promise<void> {
    const dirs = [
      path.join(this.root, "registry", "agents"),
      path.join(this.root, "registry", "rooms"),
      path.join(this.root, "rooms"),
      path.join(this.root, "dms"),
      path.join(this.root, "delivery"),
    ];
    for (const dir of dirs) {
      await fs.mkdir(dir, { recursive: true });
    }
  }

  // -----------------------------------------------------------------------
  // Listener management — not supported by FileStore
  // -----------------------------------------------------------------------

  async addListener(): Promise<string> {
    throw new CommsError("FileStore does not support listener management", "NOT_SUPPORTED");
  }

  async removeListener(): Promise<void> {
    throw new CommsError("FileStore does not support listener management", "NOT_SUPPORTED");
  }

  listListeners(): import("./transport.js").ListenerInfo[] {
    return [];
  }

  getNetworkInterfaces(): import("./types.js").NetworkInterface[] {
    return [];
  }
}

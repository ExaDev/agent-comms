/**
 * Tool handler — processes CommsAction objects and returns human-readable results.
 *
 * This is the shared logic that every bridge calls into. Bridges just:
 *   1. Parse the LLM's tool call into a CommsAction
 *   2. Call handleAction(action)
 *   3. Return the result string to the LLM
 */

import type {
  AgentId,
  AgentIdentity,
  CommsAction,
  Room,
  RoomMessage,
} from "./types.js";
import type { CommsStore } from "./comms-store.js";
import type { DiscoveryManager } from "./discovery.js";
import { CommsError } from "./store.js";

export interface CommsContext {
  agentId: AgentId;
  harness: AgentIdentity["harness"];
  cwd: string;
  pid: number;
}

export interface CommsResult {
  content: string;
  /** If true, the result is an error. */
  isError: boolean;
}

export class CommsTool {
  constructor(
    private readonly store: CommsStore,
    private readonly discovery?: DiscoveryManager,
  ) {}

  async handle(ctx: CommsContext, action: CommsAction): Promise<CommsResult> {
    try {
      switch (action.action) {
        case "register":
          return await this.register(ctx, action);
        case "update":
          return await this.update(ctx, action);
        case "whoami":
          return await this.whoami(ctx);
        case "create_room":
          return await this.createRoom(ctx, action);
        case "list_rooms":
          return await this.listRooms(ctx);
        case "join_room":
          return await this.joinRoom(ctx, action);
        case "leave_room":
          return await this.leaveRoom(ctx, action);
        case "send":
          return await this.send(ctx, action);
        case "dm":
          return await this.dm(ctx, action);
        case "list_agents":
          return await this.listAgents(ctx);
        case "read_room":
          return await this.readRoom(ctx, action);
        case "invite":
          return await this.invite(ctx, action);
        case "decline_invite":
          return await this.declineInvite(ctx, action);
        case "kick":
          return await this.kick(ctx, action);
        case "destroy_room":
          return await this.destroyRoom(ctx, action);
        case "mesh_discover":
          return await this.meshDiscover(action);
        case "mesh_advertise":
          return await this.meshAdvertise(ctx, action);
        case "mesh_unadvertise":
          return await this.meshUnadvertise(action);
        default:
          return {
            content: `Unknown action: ${JSON.stringify(action).slice(0, 100)}`,
            isError: true,
          };
      }
    } catch (err) {
      if (err instanceof CommsError) {
        return {
          content: `Error: ${err.message} (${err.code})`,
          isError: true,
        };
      }
      return {
        content: `Internal error: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }

  private async register(
    ctx: CommsContext,
    action: CommsAction & { action: "register" },
  ): Promise<CommsResult> {
    const agent = await this.store.registerAgent({
      name: action.name,
      harness: ctx.harness,
      cwd: ctx.cwd,
      pid: ctx.pid,
      visibility: action.visibility,
      tags: action.tags,
    });
    return {
      content: `Registered as ${agent.name} (${agent.id}) with visibility "${agent.visibility}".`,
      isError: false,
    };
  }

  private async update(
    ctx: CommsContext,
    action: CommsAction & { action: "update" },
  ): Promise<CommsResult> {
    const patch: Partial<
      Pick<AgentIdentity, "name" | "visibility" | "status" | "tags" | "pid">
    > = {};
    if (action.visibility !== undefined) patch.visibility = action.visibility;
    if (action.status !== undefined) patch.status = action.status;
    if (action.name !== undefined) patch.name = action.name;
    if (action.tags !== undefined) patch.tags = action.tags;
    const agent = await this.store.updateAgent(ctx.agentId, patch);
    return {
      content: `Updated: name=${agent.name}, visibility=${agent.visibility}, status=${agent.status}`,
      isError: false,
    };
  }

  private async whoami(ctx: CommsContext): Promise<CommsResult> {
    const agent = await this.store.getAgent(ctx.agentId);
    if (!agent) return { content: "Not registered.", isError: true };
    return {
      content: [
        `ID: ${agent.id}`,
        `Name: ${agent.name}`,
        `Harness: ${agent.harness}`,
        `Visibility: ${agent.visibility}`,
        `Status: ${agent.status}`,
        `Tags: ${agent.tags.join(", ") || "(none)"}`,
        `Rooms: ${agent.subscribedRooms.join(", ") || "(none)"}`,
      ].join("\n"),
      isError: false,
    };
  }

  private async createRoom(
    ctx: CommsContext,
    action: CommsAction & { action: "create_room" },
  ): Promise<CommsResult> {
    const room = await this.store.createRoom({
      name: action.name,
      type: action.type,
      owner: ctx.agentId,
      description: action.description,
    });
    // Auto-join the creator
    await this.store.joinRoom(room.id, ctx.agentId);
    return {
      content: `Created ${room.type} room "${room.name}" (${room.id}).`,
      isError: false,
    };
  }

  private async listRooms(ctx: CommsContext): Promise<CommsResult> {
    const rooms = await this.store.listRooms(ctx.agentId);
    if (rooms.length === 0)
      return { content: "No rooms found.", isError: false };

    const lines = rooms.map((r: Room) => {
      const memberFlag = r.members.includes(ctx.agentId) ? "✓" : " ";
      return `[${memberFlag}] ${r.type.padEnd(7)} ${r.name} (${String(r.members.length)} members) — ${r.description}`;
    });
    return {
      content: `Rooms ([✓] = joined):\n${lines.join("\n")}`,
      isError: false,
    };
  }

  private async joinRoom(
    ctx: CommsContext,
    action: CommsAction & { action: "join_room" },
  ): Promise<CommsResult> {
    const roomId = action.room;
    const room = await this.store.joinRoom(roomId, ctx.agentId);
    return {
      content: `Joined room "${room.name}" (${String(room.members.length)} members).`,
      isError: false,
    };
  }

  private async leaveRoom(
    ctx: CommsContext,
    action: CommsAction & { action: "leave_room" },
  ): Promise<CommsResult> {
    await this.store.leaveRoom(action.room, ctx.agentId);
    return { content: `Left room "${action.room}".`, isError: false };
  }

  private async send(
    ctx: CommsContext,
    action: CommsAction & { action: "send" },
  ): Promise<CommsResult> {
    const roomId = action.target;
    const msg = await this.store.sendRoomMessage(
      roomId,
      ctx.agentId,
      action.content,
      action.replyTo,
    );
    return {
      content: `Sent to ${action.target}: ${msg.id}`,
      isError: false,
    };
  }

  private async dm(
    ctx: CommsContext,
    action: CommsAction & { action: "dm" },
  ): Promise<CommsResult> {
    const targetId = action.target;
    const msg = await this.store.sendDm(ctx.agentId, targetId, action.content);
    return {
      content: `DM sent to ${action.target}: ${msg.id}`,
      isError: false,
    };
  }

  private async listAgents(ctx: CommsContext): Promise<CommsResult> {
    const agents = await this.store.listAgents(ctx.agentId);
    if (agents.length === 0)
      return { content: "No other agents online.", isError: false };

    const homedir = process.env.HOME ?? "";
    const abbreviateCwd = (cwd: string): string =>
      homedir && cwd.startsWith(homedir)
        ? `~${cwd.slice(homedir.length)}`
        : cwd;

    const lines = agents.map((a: AgentIdentity) => {
      const self = a.id === ctx.agentId ? " (you)" : "";
      const cwd = abbreviateCwd(a.cwd);
      const rooms =
        a.subscribedRooms.length > 0 ? a.subscribedRooms.join(", ") : "none";
      return `${a.id}  ${a.name.padEnd(25)} ${a.harness.padEnd(12)} ${a.status.padEnd(7)} ${a.visibility.padEnd(9)} ${cwd}${self}\n        Rooms: ${rooms}`;
    });
    return {
      content: `Agents:\n  ID      Name                      Harness      Status  Visibility  CWD\n${lines.map((l) => `  ${l}`).join("\n")}`,
      isError: false,
    };
  }

  private async readRoom(
    ctx: CommsContext,
    action: CommsAction & { action: "read_room" },
  ): Promise<CommsResult> {
    const roomId = action.room;
    const messages = await this.store.readRoomMessages(roomId, action.since);
    if (messages.length === 0)
      return { content: "No messages.", isError: false };

    const lines = messages.map((m: RoomMessage) => {
      const time = m.timestamp.slice(11, 19);
      return `[${time}] ${m.from}: ${m.content}`;
    });
    return { content: lines.join("\n"), isError: false };
  }

  private async invite(
    ctx: CommsContext,
    action: CommsAction & { action: "invite" },
  ): Promise<CommsResult> {
    await this.store.inviteToRoom(action.room, action.agent, ctx.agentId);
    return {
      content: `Invited ${action.agent} to ${action.room}.`,
      isError: false,
    };
  }

  private async declineInvite(
    ctx: CommsContext,
    action: CommsAction & { action: "decline_invite" },
  ): Promise<CommsResult> {
    await this.store.declineInvite(action.room, ctx.agentId, action.reason);
    return {
      content: `Declined invite to ${action.room}.`,
      isError: false,
    };
  }

  private async kick(
    ctx: CommsContext,
    action: CommsAction & { action: "kick" },
  ): Promise<CommsResult> {
    await this.store.kickFromRoom(action.room, action.agent, ctx.agentId);
    return {
      content: `Kicked ${action.agent} from ${action.room}.`,
      isError: false,
    };
  }

  private async destroyRoom(
    ctx: CommsContext,
    action: CommsAction & { action: "destroy_room" },
  ): Promise<CommsResult> {
    await this.store.destroyRoom(action.room, ctx.agentId);
    return { content: `Destroyed room "${action.room}".`, isError: false };
  }

  private async meshDiscover(
    action: CommsAction & { action: "mesh_discover" },
  ): Promise<CommsResult> {
    if (!this.discovery) {
      return {
        content: "Discovery is not available (no backends registered).",
        isError: true,
      };
    }
    const meshes = await this.discovery.discover(action.method);
    if (meshes.length === 0) {
      return { content: "No meshes discovered.", isError: false };
    }
    const lines = meshes.map(
      (m) =>
        `  ${m.host}:${String(m.port)}  ${m.name}${m.agentCount !== undefined ? ` (${String(m.agentCount)} agents)` : ""}`,
    );
    return {
      content: `Discovered meshes:\n${lines.join("\n")}`,
      isError: false,
    };
  }

  private async meshAdvertise(
    ctx: CommsContext,
    action: CommsAction & { action: "mesh_advertise" },
  ): Promise<CommsResult> {
    if (!this.discovery) {
      return {
        content: "Discovery is not available (no backends registered).",
        isError: true,
      };
    }
    // Default to the mesh coordinator port if not specified
    const port = action.port ?? 19876;
    const id = await this.discovery.advertise(action.method, {
      name: action.name,
      port,
      adapter: action.adapter,
    });
    return {
      content: `Advertising mesh "${action.name}" on ${action.method} (port ${String(port)}). ID: ${id}`,
      isError: false,
    };
  }

  private async meshUnadvertise(
    action: CommsAction & { action: "mesh_unadvertise" },
  ): Promise<CommsResult> {
    if (!this.discovery) {
      return {
        content: "Discovery is not available (no backends registered).",
        isError: true,
      };
    }
    await this.discovery.stopAdvertising(action.id);
    return { content: `Stopped advertising ${action.id}.`, isError: false };
  }
}

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
  MeshVisibility,
  NetworkInterface,
  Room,
  RoomMessage,
} from "./types.js";
import type { ListenerInfo } from "./transport.js";
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
    private readonly store: CommsStore & {
      setVisibility?(level: MeshVisibility, adapter?: string): Promise<void>;
      getVisibility?(adapter?: string): MeshVisibility;
    },
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
        case "mesh_connect":
          return await this.meshConnect(ctx, action);
        case "mesh_accept":
          return await this.meshAccept(ctx, action);
        case "mesh_reject":
          return await this.meshReject(ctx, action);
        case "mesh_pending":
          return await this.meshPending(ctx);
        case "mesh_discover":
          return await this.meshDiscover(action);
        case "mesh_advertise":
          return await this.meshAdvertise(ctx, action);
        case "mesh_unadvertise":
          return await this.meshUnadvertise(action);
        case "mesh_interfaces":
          return await this.meshInterfaces();
        case "mesh_listen":
          return await this.meshListen(ctx, action);
        case "mesh_unlisten":
          return await this.meshUnlisten(ctx, action);
        case "mesh_listeners":
          return await this.meshListeners(ctx);
        case "mesh_set_visibility":
          return await this.meshSetVisibility(action);
        case "mesh_get_visibility":
          return await this.meshGetVisibility(action);
        case "mesh_fed_connect":
          return await this.meshFedConnect(ctx, action);
        case "mesh_fed_disconnect":
          return await this.meshFedDisconnect(ctx, action);
        case "mesh_fed_links":
          return await this.meshFedLinks(ctx);
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
    const opts: { name: string; port: number; adapter?: string } = { name: action.name, port };
    if (action.adapter !== undefined) opts.adapter = action.adapter;
    const id = await this.discovery.advertise(action.method, opts);
    return {
      content: `Advertising mesh "${action.name}" on ${action.method} (port ${String(port)}). ID: ${id}`,
      isError: false,
    };
  }

  private async meshInterfaces(): Promise<CommsResult> {
    const interfaces = this.store.getNetworkInterfaces();
    if (interfaces.length === 0)
      return { content: "No network interfaces found.", isError: false };

    const lines = interfaces.map((iface: NetworkInterface) => {
      const internal = iface.internal ? " (internal)" : "";
      return `${iface.name.padEnd(12)} ${iface.family.padEnd(4)} ${iface.address}${internal}`;
    });
    return {
      content: `Interfaces:\n${lines.join("\n")}`,
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

  private async meshListen(
    _ctx: CommsContext,
    action: CommsAction & { action: "mesh_listen" },
  ): Promise<CommsResult> {
    const policy = (action.policy ?? "full") as string;
    const validPolicies = ["full", "observe", "rooms-only", "gateway"];
    if (!validPolicies.includes(policy)) {
      return {
        content: `Invalid policy "${policy}". Must be one of: ${validPolicies.join(", ")}`,
        isError: true,
      };
    }
    try {
      const id = await this.store.addListener(
        action.host,
        action.port ?? 0,
        policy as "full" | "observe" | "rooms-only" | "gateway",
      );
      return { content: `Listener added: ${id} on ${action.host}:${action.port ?? "auto"} with policy ${policy}.`, isError: false };
    } catch (err) {
      return {
        content: `Failed to add listener: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }

  private async meshUnlisten(
    _ctx: CommsContext,
    action: CommsAction & { action: "mesh_unlisten" },
  ): Promise<CommsResult> {
    try {
      await this.store.removeListener(action.id);
      return { content: `Listener ${action.id} removed.`, isError: false };
    } catch (err) {
      return {
        content: `Failed to remove listener: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }

  private async meshListeners(_ctx: CommsContext): Promise<CommsResult> {
    const listeners = this.store.listListeners();
    if (listeners.length === 0)
      return { content: "No listeners (not coordinator).", isError: false };

    const lines = listeners.map((l: ListenerInfo) => {
      const flag = l.isDefault ? " (default)" : "";
      return `${l.id}  ${l.host.padEnd(15)} ${String(l.port).padEnd(6)} ${l.policy.padEnd(11)}${flag}`;
    });
    return {
      content: `Listeners:\n  ID      Host             Port   Policy      \n${lines.map((l) => `  ${l}`).join("\n")}`,
      isError: false,
    };
  }

  private async meshSetVisibility(
    action: CommsAction & { action: "mesh_set_visibility" },
  ): Promise<CommsResult> {
    if (!this.store.setVisibility) {
      return {
        content: "Visibility control is not available on this store.",
        isError: true,
      };
    }
    await this.store.setVisibility(action.visibility, action.adapter);
    const adapter = action.adapter ? ` on adapter "${action.adapter}"` : "";
    return {
      content: `Mesh visibility set to "${action.visibility}"${adapter}.`,
      isError: false,
    };
  }

  private async meshGetVisibility(
    action: CommsAction & { action: "mesh_get_visibility" },
  ): Promise<CommsResult> {
    if (!this.store.getVisibility) {
      return {
        content: "Visibility control is not available on this store.",
        isError: true,
      };
    }
    const visibility = this.store.getVisibility();
    return {
      content: `Mesh visibility: ${visibility}`,
      isError: false,
    };
  }

  private async meshFedConnect(
    _ctx: CommsContext,
    action: CommsAction & { action: "mesh_fed_connect" },
  ): Promise<CommsResult> {
    try {
      const linkId = await this.store.fedConnect(action.host, action.port, action.name);
      return {
        content: `Federation link established: ${linkId} to ${action.host}:${String(action.port)}`,
        isError: false,
      };
    } catch (err) {
      return {
        content: `Failed to establish federation link: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }

  private async meshConnect(
    _ctx: CommsContext,
    action: CommsAction & { action: "mesh_connect" },
  ): Promise<CommsResult> {
    try {
      await this.store.connectToRemote(action.host, action.port);
      return {
        content: `Connection request sent to ${action.host}:${String(action.port)}.`,
        isError: false,
      };
    } catch (err) {
      return {
        content: `Failed to connect: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }

  private async meshFedDisconnect(
    _ctx: CommsContext,
    action: CommsAction & { action: "mesh_fed_disconnect" },
  ): Promise<CommsResult> {
    try {
      await this.store.fedDisconnect(action.linkId);
      return { content: `Federation link ${action.linkId} closed.`, isError: false };
    } catch (err) {
      return {
        content: `Failed to close federation link: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }

  private async meshAccept(
    _ctx: CommsContext,
    action: CommsAction & { action: "mesh_accept" },
  ): Promise<CommsResult> {
    try {
      await this.store.acceptConnection(action.connectionId);
      return {
        content: `Accepted connection ${action.connectionId}.`,
        isError: false,
      };
    } catch (err) {
      return {
        content: `Failed to accept: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }

  private async meshFedLinks(_ctx: CommsContext): Promise<CommsResult> {
    const links = this.store.fedLinks();
    if (links.length === 0)
      return { content: "No federation links.", isError: false };

    const lines = links.map((l) => {
      const dir = l.direction === "outbound" ? "→" : "←";
      return `${l.id}  ${dir} ${l.remoteName} (${l.remoteMeshId})`;
    });
    return {
      content: `Federation links:\n${lines.map((l) => `  ${l}`).join("\n")}`,
      isError: false,
    };
  }

  private async meshReject(
    _ctx: CommsContext,
    action: CommsAction & { action: "mesh_reject" },
  ): Promise<CommsResult> {
    try {
      await this.store.rejectConnection(action.connectionId, action.reason);
      return {
        content: `Rejected connection ${action.connectionId}: ${action.reason}`,
        isError: false,
      };
    } catch (err) {
      return {
        content: `Failed to reject: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }

  private async meshPending(_ctx: CommsContext): Promise<CommsResult> {
    const pending = this.store.listPendingConnections();
    if (pending.length === 0)
      return { content: "No pending connections.", isError: false };

    const lines = pending.map(
      (p) =>
        `${p.connectionId}  ${p.peerId}  ${p.name}  port:${String(p.dataPort)}  fp:${p.fingerprint}`,
    );
    return {
      content: `Pending connections:\n${lines.join("\n")}`,
      isError: false,
    };
  }
}

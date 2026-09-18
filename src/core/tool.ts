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
  ConnectionCode,
  MeshVisibility,
  NetworkInterface,
  Room,
  RoomMessage,
} from "./types.js";
import type { ListenerInfo } from "./transport.js";
import type { CommsStore } from "./comms-store.js";
import type { DiscoveryManager } from "./discovery.js";
import { CommsError } from "./store.js";
import { getOwnPackageVersion } from "./package-version.js";
import type {
  GenerateConnectionCodeOptions,
  RedeemConnectionCodeOptions,
  RedeemConnectionCodeResult,
} from "./connection-code.js";
import { fetchPgpPublicKeyByFingerprint } from "./pgp-keyserver.js";
import {
  handleGatewayGenerateConnectionCode,
  handleGatewayRedeemConnectionCode,
} from "./connection-code-tool.js";
import {
  gatewayTrust,
  gatewayUntrust,
  gatewayListTrusted,
} from "./gateway-trust-actions.js";

/** Table column widths for the plain-text listing helpers below, chosen to line up with the existing aligned output. */
const ROOM_TYPE_COLUMN_WIDTH = 7;
const AGENT_NAME_COLUMN_WIDTH = 25;
const AGENT_HARNESS_COLUMN_WIDTH = 12;
const AGENT_STATUS_COLUMN_WIDTH = 7;
const AGENT_VISIBILITY_COLUMN_WIDTH = 9;
const INTERFACE_NAME_COLUMN_WIDTH = 12;
const INTERFACE_FAMILY_COLUMN_WIDTH = 4;
const LISTENER_HOST_COLUMN_WIDTH = 15;
const LISTENER_PORT_COLUMN_WIDTH = 6;
const LISTENER_POLICY_COLUMN_WIDTH = 11;

/** Start/end indices into an ISO-8601 timestamp string ("YYYY-MM-DDTHH:MM:SS.sssZ") that slice out the "HH:MM:SS" portion. */
const ISO_TIME_START_INDEX = 11;
const ISO_TIME_END_INDEX = 19;

/** Maximum length of the JSON preview shown for an unrecognised action. */
const UNKNOWN_ACTION_PREVIEW_LENGTH = 100;

/** Default port the mesh coordinator listens on when advertising with no explicit port given. */
const DEFAULT_MESH_COORDINATOR_PORT = 19876;

export interface CommsContext {
  agentId: AgentId;
  harness: AgentIdentity["harness"];
  cwd: string;
  pid: number;
}

/** The calling bridge's own web UI address, as reported by the web_url action -- mirrors comms-url's own three-way distinction between a server that was never started, one whose OS-assigned port hasn't come back yet, and one that's actually reachable. */
export type WebUrlStatus =
  | { kind: "not_running" }
  | { kind: "pending" }
  | { kind: "ready"; url: string };

export interface CommsResult {
  content: string;
  /** If true, the result is an error. */
  isError: boolean;
}

/**
 * Listener management and connection approval: transport concerns CommsStore deliberately excludes (see comms-store.ts's own header) since only MeshStore, never FileStore, can support them. Every method here is optional for exactly that reason -- a CommsTool backed by a FileStore simply doesn't have them, and each call site below reports that as an ordinary CommsResult error rather than assuming they exist.
 */
export interface MeshOnlyFeatures {
  addListener?: (host: string, port: number, policy: string) => Promise<string>;
  removeListener?: (id: string) => Promise<void>;
  listListeners?: () => ListenerInfo[];
  getNetworkInterfaces?: () => NetworkInterface[];
  acceptConnection?: (connectionId: string) => Promise<void>;
  rejectConnection?: (connectionId: string, reason: string) => Promise<void>;
  listPendingConnections?: () => {
    connectionId: string;
    peerId: string;
    dataPort: number;
    name: string;
    fingerprint: string;
  }[];
  acceptRoomJoin?: (roomPath: string, requesterId: string) => void;
  rejectRoomJoin?: (
    roomPath: string,
    requesterId: string,
    reason?: string,
  ) => void;
  listPendingRoomJoins?: () => { roomPath: string; requesterId: string }[];
  acceptCapabilityRequest?: (
    requestId: string,
    options: Readonly<{
      expires: number;
      delegationsRemaining?: number;
      capability?: string;
    }>,
  ) => Promise<void>;
  rejectCapabilityRequest?: (
    requestId: string,
    reason?: string,
  ) => Promise<void>;
  listPendingCapabilityRequests?: () => {
    requestId: string;
    capability: string;
    scopeKind: string;
    scopePath?: string;
    requesterDevice: string;
  }[];
  connectToRemote?: (host: string, port: number) => Promise<void>;
  setVisibility?: (level: MeshVisibility, adapter?: string) => Promise<void>;
  getVisibility?: (adapter?: string) => MeshVisibility;
  addTrustedGateway?: (deviceHex: string) => void;
  removeTrustedGateway?: (deviceHex: string) => void;
  listTrustedGateways?: () => string[];
  generateConnectionCode?: (
    options: Readonly<GenerateConnectionCodeOptions>,
  ) => Promise<ConnectionCode>;
  redeemConnectionCode?: (
    candidate: Readonly<ConnectionCode>,
    options: Readonly<RedeemConnectionCodeOptions>,
  ) => Promise<RedeemConnectionCodeResult>;
  addTrustedGatewayPrincipal?: (deviceHex: string) => void;
  removeTrustedGatewayPrincipal?: (deviceHex: string) => void;
  listTrustedGatewayPrincipals?: () => string[];
}

/** Uniform "this bridge isn't backed by a mesh transport" result for a MeshOnlyFeatures method that isn't present on the current store. */
function notMeshBacked(action: string): CommsResult {
  return {
    isError: true,
    content: `${action} requires a mesh-backed store (this session is running on FileStore)`,
  };
}

/** Runs a mesh store call that may throw, converting a thrown error into a CommsResult instead of repeating the same try/catch at every call site. `action` performs the call and returns the success message directly. */
export async function tryMeshAction(
  verb: string,
  action: () => Promise<string>,
): Promise<CommsResult> {
  try {
    return { content: await action(), isError: false };
  } catch (err) {
    return {
      content: `Failed to ${verb}: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}

/** Synchronous counterpart to tryMeshAction, for the room-join accept/reject calls, which aren't promise-returning. */
function trySyncAction(verb: string, action: () => string): CommsResult {
  try {
    return { content: action(), isError: false };
  } catch (err) {
    return {
      content: `Failed to ${verb}: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}

export class CommsTool {
  /** Reports this bridge's own web UI address for the web_url action. Assignable post-construction, mirroring MeshStore's own onDelivery/onCoordinatorRoleChanged hooks, because the underlying web server handle isn't known until after this bridge's own tryStartWebServer() call -- which every real bridge makes after building its CommsTool, not before. Undefined (the default) means this bridge never wires web UI reporting. */
  getWebUrlStatus?: () => WebUrlStatus;

  constructor(
    private readonly store: CommsStore & MeshOnlyFeatures,
    private readonly discovery?: DiscoveryManager,
    /** Returns the newest npm release known to be available, or undefined when none is known (no checker wired up, no successful check yet, or this bridge is already current). Wired at bridge construction time by a VersionDriftChecker (see version-check.ts) -- optional so every existing call site, and every test that has no interest in drift reporting, is unaffected. */
    private readonly getNewerVersionIfAny?: () => string | undefined,
    /** Fetches a signer's armored PGP public key by fingerprint, used by gateway_redeem_connection_code when the caller supplies a fingerprint but not the key text itself. Defaults to the real keys.openpgp.org lookup (pgp-keyserver.ts); a test that would otherwise trigger real network I/O injects a fake resolver instead, the same reasoning bridge-mesh.ts's own fetchLatestVersion override already establishes for getNewerVersionIfAny above. */
    private readonly fetchPgpPublicKeyByFingerprintImpl: (
      fingerprint: string,
    ) => Promise<string> = fetchPgpPublicKeyByFingerprint,
  ) {}

  /** The "Update available: ..." line appended to whoami/update output when a newer release is known, or undefined when there's nothing to report. */
  private formatUpdateAvailableLine(): string | undefined {
    const newerVersion = this.getNewerVersionIfAny?.();
    if (newerVersion === undefined) return undefined;
    return `Update available: ${newerVersion} (running ${getOwnPackageVersion()})`;
  }

  async handle(
    ctx: Readonly<CommsContext>,
    action: CommsAction,
  ): Promise<CommsResult> {
    try {
      switch (action.action) {
        case "register":
          return await this.register(ctx, action);
        case "update":
          return await this.update(ctx, action);
        case "whoami":
          return await this.whoami(ctx);
        case "web_url":
          return this.webUrl();
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
          return this.meshPending(ctx);
        case "room_accept":
          return this.roomAccept(ctx, action);
        case "room_reject":
          return this.roomReject(ctx, action);
        case "room_pending":
          return this.roomPending(ctx);
        case "capability_accept":
          return await this.capabilityAccept(ctx, action);
        case "capability_reject":
          return await this.capabilityReject(ctx, action);
        case "capability_pending":
          return this.capabilityPending(ctx);
        case "mesh_discover":
          return await this.meshDiscover(action);
        case "mesh_advertise":
          return await this.meshAdvertise(ctx, action);
        case "mesh_unadvertise":
          return await this.meshUnadvertise(action);
        case "mesh_interfaces":
          return this.meshInterfaces();
        case "mesh_listen":
          return await this.meshListen(ctx, action);
        case "mesh_unlisten":
          return await this.meshUnlisten(ctx, action);
        case "mesh_listeners":
          return this.meshListeners(ctx);
        case "mesh_set_visibility":
          return await this.meshSetVisibility(action);
        case "mesh_get_visibility":
          return this.meshGetVisibility(action);
        case "gateway_trust":
          return gatewayTrust(this.store, action);
        case "gateway_untrust":
          return gatewayUntrust(this.store, action);
        case "gateway_list_trusted":
          return gatewayListTrusted(this.store);
        case "gateway_generate_connection_code":
          return await handleGatewayGenerateConnectionCode(this.store, action);
        case "gateway_redeem_connection_code":
          return await handleGatewayRedeemConnectionCode(
            this.store,
            action,
            this.fetchPgpPublicKeyByFingerprintImpl,
          );
        default:
          return {
            content: `Unknown action: ${JSON.stringify(action).slice(0, UNKNOWN_ACTION_PREVIEW_LENGTH)}`,
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
    ctx: Readonly<CommsContext>,
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
    ctx: Readonly<CommsContext>,
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
    const lines = [
      `Updated: name=${agent.name}, visibility=${agent.visibility}, status=${agent.status}, version=${getOwnPackageVersion()}`,
    ];
    const updateAvailable = this.formatUpdateAvailableLine();
    if (updateAvailable !== undefined) lines.push(updateAvailable);
    return {
      content: lines.join("\n"),
      isError: false,
    };
  }

  private async whoami(ctx: Readonly<CommsContext>): Promise<CommsResult> {
    const agent = await this.store.getAgent(ctx.agentId);
    if (!agent) return { content: "Not registered.", isError: true };
    const lines = [
      `ID: ${agent.id}`,
      `Name: ${agent.name}`,
      `Harness: ${agent.harness}`,
      `Visibility: ${agent.visibility}`,
      `Status: ${agent.status}`,
      `Version: ${getOwnPackageVersion()}`,
      `Tags: ${agent.tags.join(", ") || "(none)"}`,
      `Rooms: ${agent.subscribedRooms.join(", ") || "(none)"}`,
    ];
    const updateAvailable = this.formatUpdateAvailableLine();
    if (updateAvailable !== undefined) lines.push(updateAvailable);
    return {
      content: lines.join("\n"),
      isError: false,
    };
  }

  private webUrl(): CommsResult {
    const status = this.getWebUrlStatus?.() ?? { kind: "not_running" };
    switch (status.kind) {
      case "not_running":
        return { content: "Web UI is not running.", isError: true };
      case "pending":
        return { content: "Web UI port not yet assigned.", isError: true };
      case "ready":
        return { content: status.url, isError: false };
      default:
        return status satisfies never;
    }
  }

  private async createRoom(
    ctx: Readonly<CommsContext>,
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

  private async listRooms(ctx: Readonly<CommsContext>): Promise<CommsResult> {
    const rooms = await this.store.listRooms(ctx.agentId);
    if (rooms.length === 0)
      return { content: "No rooms found.", isError: false };

    const lines = rooms.map((r: Room) => {
      const memberFlag = r.members.includes(ctx.agentId) ? "✓" : " ";
      return `[${memberFlag}] ${r.type.padEnd(ROOM_TYPE_COLUMN_WIDTH)} ${r.name} (${String(r.members.length)} members) — ${r.description}`;
    });
    return {
      content: `Rooms ([✓] = joined):\n${lines.join("\n")}`,
      isError: false,
    };
  }

  private async joinRoom(
    ctx: Readonly<CommsContext>,
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
    ctx: Readonly<CommsContext>,
    action: CommsAction & { action: "leave_room" },
  ): Promise<CommsResult> {
    await this.store.leaveRoom(action.room, ctx.agentId);
    return { content: `Left room "${action.room}".`, isError: false };
  }

  private async send(
    ctx: Readonly<CommsContext>,
    action: CommsAction & { action: "send" },
  ): Promise<CommsResult> {
    const roomId = action.target;
    const msg = await this.store.sendRoomMessage(
      roomId,
      ctx.agentId,
      action.content,
      action.replyTo,
      action.streamingBehavior,
    );
    return {
      content: `Sent to ${action.target}: ${msg.id}`,
      isError: false,
    };
  }

  private async dm(
    ctx: Readonly<CommsContext>,
    action: CommsAction & { action: "dm" },
  ): Promise<CommsResult> {
    const targetId = action.target;
    const msg = await this.store.sendDm(
      ctx.agentId,
      targetId,
      action.content,
      action.streamingBehavior,
    );
    return {
      content: `DM sent to ${action.target}: ${msg.id}`,
      isError: false,
    };
  }

  private async listAgents(ctx: Readonly<CommsContext>): Promise<CommsResult> {
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
      return `${a.id}  ${a.name.padEnd(AGENT_NAME_COLUMN_WIDTH)} ${a.harness.padEnd(AGENT_HARNESS_COLUMN_WIDTH)} ${a.status.padEnd(AGENT_STATUS_COLUMN_WIDTH)} ${a.visibility.padEnd(AGENT_VISIBILITY_COLUMN_WIDTH)} ${cwd}${self}\n        Rooms: ${rooms}`;
    });
    return {
      content: `Agents:\n  ID      Name                      Harness      Status  Visibility  CWD\n${lines.map((l) => `  ${l}`).join("\n")}`,
      isError: false,
    };
  }

  private async readRoom(
    ctx: Readonly<CommsContext>,
    action: CommsAction & { action: "read_room" },
  ): Promise<CommsResult> {
    const roomId = action.room;
    const messages = await this.store.readRoomMessages(roomId, action.since);
    if (messages.length === 0)
      return { content: "No messages.", isError: false };

    const lines = messages.map((m: RoomMessage) => {
      const time = m.timestamp.slice(ISO_TIME_START_INDEX, ISO_TIME_END_INDEX);
      return `[${time}] ${m.from}: ${m.content}`;
    });
    return { content: lines.join("\n"), isError: false };
  }

  private async invite(
    ctx: Readonly<CommsContext>,
    action: CommsAction & { action: "invite" },
  ): Promise<CommsResult> {
    await this.store.inviteToRoom(action.room, action.agent, ctx.agentId);
    return {
      content: `Invited ${action.agent} to ${action.room}.`,
      isError: false,
    };
  }

  private async declineInvite(
    ctx: Readonly<CommsContext>,
    action: CommsAction & { action: "decline_invite" },
  ): Promise<CommsResult> {
    await this.store.declineInvite(action.room, ctx.agentId, action.reason);
    return {
      content: `Declined invite to ${action.room}.`,
      isError: false,
    };
  }

  private async kick(
    ctx: Readonly<CommsContext>,
    action: CommsAction & { action: "kick" },
  ): Promise<CommsResult> {
    await this.store.kickFromRoom(action.room, action.agent, ctx.agentId);
    return {
      content: `Kicked ${action.agent} from ${action.room}.`,
      isError: false,
    };
  }

  private async destroyRoom(
    ctx: Readonly<CommsContext>,
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
    ctx: Readonly<CommsContext>,
    action: CommsAction & { action: "mesh_advertise" },
  ): Promise<CommsResult> {
    if (!this.discovery) {
      return {
        content: "Discovery is not available (no backends registered).",
        isError: true,
      };
    }
    // Default to the mesh coordinator port if not specified
    const port = action.port ?? DEFAULT_MESH_COORDINATOR_PORT;
    const opts: { name: string; port: number; adapter?: string } = {
      name: action.name,
      port,
    };
    if (action.adapter !== undefined) opts.adapter = action.adapter;
    const id = await this.discovery.advertise(action.method, opts);
    return {
      content: `Advertising mesh "${action.name}" on ${action.method} (port ${String(port)}). ID: ${id}`,
      isError: false,
    };
  }

  private meshInterfaces(): CommsResult {
    if (!this.store.getNetworkInterfaces)
      return notMeshBacked("mesh_interfaces");
    const interfaces = this.store.getNetworkInterfaces();
    if (interfaces.length === 0)
      return { content: "No network interfaces found.", isError: false };

    const lines = interfaces.map((iface: Readonly<NetworkInterface>) => {
      const internal = iface.internal ? " (internal)" : "";
      return `${iface.name.padEnd(INTERFACE_NAME_COLUMN_WIDTH)} ${iface.family.padEnd(INTERFACE_FAMILY_COLUMN_WIDTH)} ${iface.address}${internal}`;
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
    _ctx: Readonly<CommsContext>,
    action: CommsAction & { action: "mesh_listen" },
  ): Promise<CommsResult> {
    const policy = action.policy ?? "full";
    const validPolicies = ["full", "observe", "rooms-only", "gateway"];
    if (!validPolicies.includes(policy)) {
      return {
        content: `Invalid policy "${policy}". Must be one of: ${validPolicies.join(", ")}`,
        isError: true,
      };
    }
    if (!this.store.addListener) return notMeshBacked("mesh_listen");
    const addListener = this.store.addListener.bind(this.store);
    return tryMeshAction("add listener", async () => {
      const id = await addListener(action.host, action.port ?? 0, policy);
      return `Listener added: ${id} on ${action.host}${String(action.port ?? "auto")} with policy ${policy}.`;
    });
  }

  private async meshUnlisten(
    _ctx: Readonly<CommsContext>,
    action: CommsAction & { action: "mesh_unlisten" },
  ): Promise<CommsResult> {
    if (!this.store.removeListener) return notMeshBacked("mesh_unlisten");
    const removeListener = this.store.removeListener.bind(this.store);
    return tryMeshAction("remove listener", async () => {
      await removeListener(action.id);
      return `Listener ${action.id} removed.`;
    });
  }

  private meshListeners(_ctx: Readonly<CommsContext>): CommsResult {
    if (!this.store.listListeners) return notMeshBacked("mesh_listeners");
    const listeners = this.store.listListeners();
    if (listeners.length === 0)
      return { content: "No listeners (not coordinator).", isError: false };

    const lines = listeners.map((l: Readonly<ListenerInfo>) => {
      const flag = l.isDefault ? " (default)" : "";
      return `${l.id}  ${l.host.padEnd(LISTENER_HOST_COLUMN_WIDTH)} ${String(l.port).padEnd(LISTENER_PORT_COLUMN_WIDTH)} ${l.policy.padEnd(LISTENER_POLICY_COLUMN_WIDTH)}${flag}`;
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
    const adapter =
      action.adapter !== undefined ? ` on adapter "${action.adapter}"` : "";
    return {
      content: `Mesh visibility set to "${action.visibility}"${adapter}.`,
      isError: false,
    };
  }

  private meshGetVisibility(
    _action: CommsAction & { action: "mesh_get_visibility" },
  ): CommsResult {
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

  private async meshConnect(
    _ctx: Readonly<CommsContext>,
    action: CommsAction & { action: "mesh_connect" },
  ): Promise<CommsResult> {
    if (!this.store.connectToRemote) return notMeshBacked("mesh_connect");
    const connectToRemote = this.store.connectToRemote.bind(this.store);
    return tryMeshAction("connect", async () => {
      await connectToRemote(action.host, action.port);
      const target = /^wss?:\/\//.test(action.host)
        ? action.host
        : `${action.host}:${String(action.port)}`;
      return `Connection request sent to ${target}.`;
    });
  }

  private async meshAccept(
    _ctx: Readonly<CommsContext>,
    action: CommsAction & { action: "mesh_accept" },
  ): Promise<CommsResult> {
    if (!this.store.acceptConnection) return notMeshBacked("mesh_accept");
    const acceptConnection = this.store.acceptConnection.bind(this.store);
    return tryMeshAction("accept", async () => {
      await acceptConnection(action.connectionId);
      return `Accepted connection ${action.connectionId}.`;
    });
  }

  private async meshReject(
    _ctx: Readonly<CommsContext>,
    action: CommsAction & { action: "mesh_reject" },
  ): Promise<CommsResult> {
    if (!this.store.rejectConnection) return notMeshBacked("mesh_reject");
    const rejectConnection = this.store.rejectConnection.bind(this.store);
    return tryMeshAction("reject", async () => {
      await rejectConnection(action.connectionId, action.reason);
      return `Rejected connection ${action.connectionId}: ${action.reason}`;
    });
  }

  private meshPending(_ctx: Readonly<CommsContext>): CommsResult {
    if (!this.store.listPendingConnections)
      return notMeshBacked("mesh_pending");
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

  private roomAccept(
    _ctx: Readonly<CommsContext>,
    action: CommsAction & { action: "room_accept" },
  ): CommsResult {
    if (!this.store.acceptRoomJoin) return notMeshBacked("room_accept");
    const acceptRoomJoin = this.store.acceptRoomJoin.bind(this.store);
    return trySyncAction("accept", () => {
      acceptRoomJoin(action.room, action.requesterId);
      return `Accepted ${action.requesterId}'s request to join ${action.room}.`;
    });
  }

  private roomReject(
    _ctx: Readonly<CommsContext>,
    action: CommsAction & { action: "room_reject" },
  ): CommsResult {
    if (!this.store.rejectRoomJoin) return notMeshBacked("room_reject");
    const rejectRoomJoin = this.store.rejectRoomJoin.bind(this.store);
    return trySyncAction("reject", () => {
      rejectRoomJoin(action.room, action.requesterId, action.reason);
      return `Rejected ${action.requesterId}'s request to join ${action.room}.`;
    });
  }

  private roomPending(_ctx: Readonly<CommsContext>): CommsResult {
    if (!this.store.listPendingRoomJoins) return notMeshBacked("room_pending");
    const pending = this.store.listPendingRoomJoins();
    if (pending.length === 0)
      return { content: "No pending room join requests.", isError: false };

    const lines = pending.map((p) => `${p.roomPath}  ${p.requesterId}`);
    return {
      content: `Pending room join requests:\n${lines.join("\n")}`,
      isError: false,
    };
  }

  private async capabilityAccept(
    _ctx: Readonly<CommsContext>,
    action: CommsAction & { action: "capability_accept" },
  ): Promise<CommsResult> {
    if (!this.store.acceptCapabilityRequest)
      return notMeshBacked("capability_accept");
    const acceptCapabilityRequest = this.store.acceptCapabilityRequest.bind(
      this.store,
    );
    return tryMeshAction("accept", async () => {
      await acceptCapabilityRequest(action.requestId, {
        expires: action.expires,
        ...(action.delegationsRemaining !== undefined
          ? { delegationsRemaining: action.delegationsRemaining }
          : {}),
        ...(action.capability !== undefined
          ? { capability: action.capability }
          : {}),
      });
      return `Accepted capability request ${action.requestId}.`;
    });
  }

  private async capabilityReject(
    _ctx: Readonly<CommsContext>,
    action: CommsAction & { action: "capability_reject" },
  ): Promise<CommsResult> {
    if (!this.store.rejectCapabilityRequest)
      return notMeshBacked("capability_reject");
    const rejectCapabilityRequest = this.store.rejectCapabilityRequest.bind(
      this.store,
    );
    return tryMeshAction("reject", async () => {
      await rejectCapabilityRequest(action.requestId, action.reason);
      return `Rejected capability request ${action.requestId}.`;
    });
  }

  private capabilityPending(_ctx: Readonly<CommsContext>): CommsResult {
    if (!this.store.listPendingCapabilityRequests)
      return notMeshBacked("capability_pending");
    const pending = this.store.listPendingCapabilityRequests();
    if (pending.length === 0)
      return { content: "No pending capability requests.", isError: false };

    const lines = pending.map(
      (p) =>
        `${p.requestId}  ${p.capability}  ${p.scopeKind}${p.scopePath !== undefined ? `:${p.scopePath}` : ""}  from ${p.requesterDevice}`,
    );
    return {
      content: `Pending capability requests:\n${lines.join("\n")}`,
      isError: false,
    };
  }
}

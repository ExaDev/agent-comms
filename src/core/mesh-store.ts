/**
 * MeshStore — transport-agnostic peer mesh for agent communication.
 *
 * Each bridge instance is a peer in the mesh. Peers discover each other via a coordinator (the first instance to bind the well-known port). All state is held in memory and synchronised between peers. Delivery events are pushed directly over the transport — no polling, no filesystem.
 *
 * Transport is set via setTransport() (e.g. WireMeshTransport for encrypted connections) before init() or any other transport-using method is called -- there is no default, since every real bridge builds its own transport from this store's own events getter, which needs the store to already exist.
 *
 * MeshStore itself is an orchestrator: it owns the shared state (the core agents/rooms/messages/dms/deliveryQueues Maps and a handful of smaller fields) and constructs the collaborators that implement almost every behaviour against direct references into that state -- DeliveryEngine, RoomProtocol, RoomMessaging, RoomLifecycle, AgentRegistry, ConnectionApproval, StaleAgentChecker, and PeerLifecycle. Every public method below that isn't inherently a MeshStore-level concern (transport/identity wiring, init/shutdown lifecycle, the events getter, mesh visibility, listener management) is a thin delegating wrapper to whichever collaborator now owns the real implementation, kept here only because CommsStore/MeshOnlyFeatures and a handful of concrete-only call sites (tests, bridge-mesh.ts, the web server, etc.) reach these names directly on a MeshStore-typed value.
 */

import * as os from "node:os";
import { nanoid } from "./nanoid.js";
import { ROOM_JOIN_APPROVAL_TIMEOUT_MS } from "./request-timeouts.js";
import { CommsError } from "./store.js";
import { DiscoveryManager } from "./discovery.js";
import { MdnsDiscoveryBackend } from "./discovery-mdns.js";
import { TailscaleDiscoveryBackend } from "./discovery-tailscale.js";
import { COORDINATOR_HOST, DEFAULT_HUB_URL } from "./mesh-store-shared.js";
import type { MeshStoreIdentity } from "./mesh-store-shared.js";
import { CoordinatorGateway } from "./coordinator-gateway.js";
import { GatewayTrust } from "./gateway-trust.js";
import {
  ConnectionCodeLedger,
  type GenerateConnectionCodeOptions,
  type RedeemConnectionCodeOptions,
  type RedeemConnectionCodeResult,
} from "./connection-code.js";
import type { IdentitySlot } from "./identity-store.js";
import { DeliveryEngine } from "./delivery-engine.js";
import { RoomProtocol } from "./room-protocol.js";
import { RoomMessaging } from "./room-messaging.js";
import { RoomLifecycle } from "./room-lifecycle.js";
import { AgentRegistry } from "./agent-registry.js";
import { ConnectionApproval } from "./connection-approval.js";
import { CapabilityAskAdmission } from "./capability-ask.js";
import type {
  IncomingManageRequest,
  ManageOutcome,
} from "wire-mesh-core/domain/mesh-session";
import type { DeviceId } from "wire-mesh-core/generated/protocol";
import { StaleAgentChecker } from "./stale-agent-checker.js";
import { PeerLifecycle } from "./peer-lifecycle.js";
import type { RoomVerbHandler } from "./room-router.js";
import type { AgentSelfAdvert, HostedRoomAdvert } from "./gossip-extensions.js";
import {
  getPeerAgentCommsVersions,
  getPeerWireMeshCoreVersion,
} from "./peer-versions.js";
import type {
  MeshStatePatch,
  PeerInfo,
  SerialisedState,
} from "./wire-protocol.js";
import type {
  ListenerInfo,
  ListenerPolicy,
  MeshGraph,
  MeshTraceResult,
  MeshTransport,
  TransportEvents,
} from "./transport.js";
import type { CommsStore, SendRoomMessageOptions } from "./comms-store.js";
import type { CapabilityToken } from "wire-mesh-core/generated/protocol";
import type {
  AgentIdentity,
  AgentStatus,
  ConnectionCode,
  DeliveryEvent,
  DmMessage,
  MeshVisibility,
  NetworkInterface,
  Room,
  RoomMessage,
  RoomType,
  StreamingBehavior,
  Visibility,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_COORDINATOR_PORT = 19876;
/** Length of the randomly generated peer ID. */
const PEER_ID_LENGTH = 8;

// ---------------------------------------------------------------------------
// MeshStore
// ---------------------------------------------------------------------------

/** Construction options for MeshStore. */
export interface MeshStoreOptions {
  /** Localhost TCP port the coordinator role is contested on. Defaults to DEFAULT_COORDINATOR_PORT. */
  readonly coordinatorPort?: number | undefined;
  /** Remote gateway hub this store dials whenever it holds the local coordinator role. Defaults to DEFAULT_HUB_URL. */
  readonly hubUrl?: string | undefined;
  /** How long a room.join (including a first-contact DM request) may await a human decision, on this store as the receiver and on the transport it is wired to as the sender. Defaults to ROOM_JOIN_APPROVAL_TIMEOUT_MS; a test shortens it. */
  readonly roomJoinApprovalTimeoutMs?: number | undefined;
  /** Shared between gatewayTrust and connectionCodes -- both are per-slot persisted bootstrap state for the same trust boundary, so a single slot is this store's one notion of "which bridge instance's own disk state this is". */
  readonly slot?: Readonly<IdentitySlot>;
}

export class MeshStore implements CommsStore {
  peerId: string;
  readonly startedAt: string;
  readonly coordinatorPort: number;
  private readonly hubUrl: string;
  /** Read by whoever wires this store to a transport, so both halves of a room.join agree on the approval window. */
  readonly roomJoinApprovalTimeoutMs: number;

  private readonly agents = new Map<string, AgentIdentity>();
  private readonly rooms = new Map<string, Room>();
  private readonly messages = new Map<string, RoomMessage[]>();
  private readonly dms = new Map<string, DmMessage[]>();
  private readonly deliveryQueues = new Map<string, DeliveryEvent[]>();
  private readonly identityCache = new Map<string, { id: string }>();
  private readonly peerInfo = new Map<string, PeerInfo>();
  private readonly localDeliveryKeys = new Set<string>();
  private readonly pendingMarkReadTimers: ReturnType<typeof setTimeout>[] = [];
  /** DM paths this store has itself sent an outbound room.join for -- section 6's own basis for auto-approving the counterpart's reciprocal room.join without a second human decision. Shared between RoomProtocol (reads, in handleRoomJoin) and RoomLifecycle (writes, in requestDmAccess). Never cleared: a DM conversation, once opened, stays open, and holding a stale entry here costs nothing beyond a few bytes per DM this node has ever initiated. */
  private readonly dmRequestsInitiatedByMe = new Set<string>();

  private transport: MeshTransport | undefined;
  private storeIdentity: MeshStoreIdentity | undefined;
  private isShutDown = false;
  private initialised = false;

  discovery: DiscoveryManager;

  /** The cross-machine trust boundary (agent-comms#156), constructed once in the constructor below (mirroring discovery above) and shared with WireMeshTransport by every construction site (bridge-mesh.ts, test-transport.ts) that passes it into WireMeshTransport's own constructor, so store.addTrustedGateway() and the transport's own hub-forwarding/hub-session gates read the exact same set. Persists across restarts (agent-comms#186) when a slot is passed to this store's own constructor; stays in-memory only, exactly as before, for every construction site that omits one. Public so those construction sites can reach it; addTrustedGateway/removeTrustedGateway/listTrustedGateways below are the methods CommsTool actually calls through MeshOnlyFeatures. */
  readonly gatewayTrust: GatewayTrust;

  /** The connection-code generate/redeem pair (agent-comms#188) bootstrapping gatewayTrust above between two devices with no existing mesh connection. Persists across restarts the same way gatewayTrust does, sharing the same slot passed to this store's own constructor. generateConnectionCode/redeemConnectionCode below are the methods CommsTool actually calls through MeshOnlyFeatures; redeemConnectionCode is also where a successful redemption's deviceId gets fed into gatewayTrust.add, the actual point of this whole bootstrap. */
  private readonly connectionCodes: ConnectionCodeLedger;

  private readonly deliveryEngine: DeliveryEngine;
  private readonly roomProtocol: RoomProtocol;
  private readonly roomMessaging: RoomMessaging;
  private readonly roomLifecycle: RoomLifecycle;
  private readonly agentRegistry: AgentRegistry;
  private readonly connectionApproval: ConnectionApproval;
  private readonly capabilityAskAdmission: CapabilityAskAdmission;
  private readonly staleAgentChecker: StaleAgentChecker;
  private readonly coordinatorGateway: CoordinatorGateway;
  private readonly peerLifecycle: PeerLifecycle;

  /** This store's own current AgentStatus, synchronously -- the value WireMeshTransport's presence re-advertisement timer reads on every tick. undefined before registerAgent has ever run (no self agent record exists yet), in which case there is nothing yet to advertise. */
  get selfStatus(): AgentStatus | undefined {
    return this.agents.get(this.peerId)?.status;
  }

  /** This store's own currently-hosted public/private rooms, synchronously, in the lightweight gossip-safe shape WireMeshTransport's own hosted-rooms re-advertisement timer reads on every tick -- the write half of P3.8's room-discovery replacement for createRoom's own broadcastPatch (agent-comms#48). Secret rooms are never included (never worth advertising at all), and a room this store has merely replicated via the legacy room_upsert broadcast, rather than owns, is excluded too -- "hosted" means "this device is the one a joiner should actually reach", which only its own owner is. */
  get hostedRooms(): readonly HostedRoomAdvert[] {
    const result: HostedRoomAdvert[] = [];
    for (const room of this.rooms.values()) {
      if (room.owner !== this.peerId) continue;
      if (room.type !== "public" && room.type !== "private") continue;
      result.push({
        path: room.id,
        name: room.name,
        type: room.type,
        description: room.description,
      });
    }
    return result;
  }

  /** This store's own gossip-safe agent-identity advert, synchronously, in the shape WireMeshTransport's own gossip re-advertisement timer reads on every tick -- the write half of P3.8's eventual agent register/update/offline retirement (agent-comms#48). undefined before registerAgent has ever run (nothing to advertise yet), or when this agent's own visibility isn't "visible" -- gossip already reaches every connected peer regardless of mesh-approval status (see wire-mesh-transport.ts's own allSessions/quarantine comments), so advertising a hidden or ghost agent's identity this way would leak exactly what those visibility levels exist to withhold. */
  get selfAgentAdvert(): AgentSelfAdvert | undefined {
    const agent = this.agents.get(this.peerId);
    if (agent?.visibility !== "visible") return undefined;
    return {
      name: agent.name,
      harness: agent.harness,
      cwd: agent.cwd,
      pid: agent.pid,
      startedAt: agent.startedAt,
      tags: agent.tags,
      subscribedRooms: agent.subscribedRooms,
    };
  }

  /** Whether the mesh has a live coordinator connection. */
  get connected(): boolean {
    return (
      this.requireTransport().isCoordinator ||
      this.requireTransport().hasCoordinatorConnection
    );
  }

  onDelivery:
    | ((agentId: string, event: DeliveryEvent) => void | Promise<void>)
    | undefined;

  /** Fires for every state patch — both locally generated and remote. */
  onPatch: ((patch: MeshStatePatch) => void | Promise<void>) | undefined;

  /**
   * Fires for a transport-level error a caller may want to observe (a connection rejected for presenting a certificate that doesn't match its claimed peer ID, this store's own inability to join or create a mesh, etc). Left undefined by default (matching onDelivery/onPatch): a caller that wants visibility sets it, exactly like those two.
   */
  onError: ((error: Error) => void) | undefined;

  /**
   * Fires whenever this store's own coordinator role changes: true right after becoming coordinator (a fresh bind in init(), or a takeover via PeerLifecycle.handleBecomeCoordinator), false right before shutdown() drops it. There is no live "lost the role to someone else while still running" case today -- CoordinatorGateway.onLostCoordinator is only ever called from shutdown(), so this callback mirrors that same lifecycle. Left undefined by default (matching onDelivery/onPatch/onError): a caller that wants to react to owning the coordinator role -- e.g. bridge-mesh.ts starting/stopping the cc-peer front (agent-comms#157), a Node/filesystem-specific capability that has no place in this transport-agnostic core -- sets it, exactly like those three.
   */
  onCoordinatorRoleChanged:
    ((isCoordinator: boolean) => void | Promise<void>) | undefined;

  /** This process's own currently-running cc-peer package version, when it is actually fronting a cc-peer session or running the one-shot `bridge cc-peer` command (agent-comms#198) -- undefined by default (matching onDelivery/onPatch/onError/onCoordinatorRoleChanged), since every other bridge never loads the cc-peer package at all. Set once, right after construction, by front-runtime.ts/bridges/cc-peer/run.ts (a plain closure over cc-peer's own exported CC_PEER_VERSION constant) -- read by both this store's own WireMeshTransport construction (bridge-mesh.ts, for the gossiped versions advert) and CommsTool (for whoami/update/list_agents' own self-report), so the one field backs both surfaces. */
  getCcPeerVersion: (() => string | undefined) | undefined;

  /** Serialise the full mesh state for state_sync messages. */
  serialise(): SerialisedState {
    return {
      agents: Object.fromEntries(this.agents),
      rooms: Object.fromEntries(this.rooms),
      messages: Object.fromEntries(this.messages),
      dms: Object.fromEntries(this.dms),
      deliveryQueues: Object.fromEntries(this.deliveryQueues),
    };
  }

  constructor(options?: Readonly<MeshStoreOptions>) {
    const {
      coordinatorPort = DEFAULT_COORDINATOR_PORT,
      hubUrl = DEFAULT_HUB_URL,
      roomJoinApprovalTimeoutMs = ROOM_JOIN_APPROVAL_TIMEOUT_MS,
      slot,
    } = options ?? {};
    this.peerId = nanoid(PEER_ID_LENGTH);
    this.startedAt = new Date().toISOString();
    this.coordinatorPort = coordinatorPort;
    this.hubUrl = hubUrl;
    this.roomJoinApprovalTimeoutMs = roomJoinApprovalTimeoutMs;
    this.gatewayTrust = new GatewayTrust(slot);
    this.connectionCodes = new ConnectionCodeLedger(slot);

    // Discovery manager — registers available backends
    this.discovery = new DiscoveryManager();
    this.discovery.registerBackend(new MdnsDiscoveryBackend());
    this.discovery.registerBackend(new TailscaleDiscoveryBackend());

    this.deliveryEngine = new DeliveryEngine({
      agents: this.agents,
      rooms: this.rooms,
      messages: this.messages,
      dms: this.dms,
      deliveryQueues: this.deliveryQueues,
      localDeliveryKeys: this.localDeliveryKeys,
      pendingMarkReadTimers: this.pendingMarkReadTimers,
      getPeerId: () => this.peerId,
      requireIdentity: () => this.requireIdentity(),
      requireTransport: () => this.requireTransport(),
      getOnDelivery: () => this.onDelivery,
      getOnPatch: () => this.onPatch,
      isShutDown: () => this.isShutDown,
      // RoomProtocol doesn't exist yet at this point in the constructor -- this closure resolves `this.roomProtocol` lazily, only once markRead actually calls it at runtime, well after the constructor has finished.
      sendRoomRequestToMember: async (memberId, roomPath, token, params) =>
        this.roomProtocol.sendRoomRequestToMember(
          memberId,
          roomPath,
          token,
          params,
        ),
    });

    this.roomProtocol = new RoomProtocol({
      rooms: this.rooms,
      messages: this.messages,
      dms: this.dms,
      agents: this.agents,
      dmRequestsInitiatedByMe: this.dmRequestsInitiatedByMe,
      getPeerId: () => this.peerId,
      requireIdentity: () => this.requireIdentity(),
      requireTransport: () => this.requireTransport(),
      deliveryEngine: this.deliveryEngine,
      joinDecisionTimeoutMs: this.roomJoinApprovalTimeoutMs,
      // RoomLifecycle doesn't exist yet at this point -- deferred the same way DeliveryEngine's sendRoomRequestToMember closure above is.
      revokeMemberGrant: async (roomId, memberId) =>
        this.roomLifecycle.revokeMemberGrant(roomId, memberId),
    });

    this.roomMessaging = new RoomMessaging({
      rooms: this.rooms,
      messages: this.messages,
      dms: this.dms,
      requireIdentity: () => this.requireIdentity(),
      roomProtocol: this.roomProtocol,
      // RoomLifecycle doesn't exist yet at this point -- deferred the same lazy-`this`-capture way as the closures above.
      requestDmAccess: async (counterpart) =>
        this.roomLifecycle.requestDmAccess(counterpart),
      // AgentRegistry doesn't exist yet at this point in the constructor -- deferred the same lazy-`this`-capture way DeliveryEngine's own sendRoomRequestToMember closure above is.
      resolveAgent: async (id) => this.agentRegistry.getAgent(id),
    });

    this.roomLifecycle = new RoomLifecycle({
      rooms: this.rooms,
      messages: this.messages,
      agents: this.agents,
      dmRequestsInitiatedByMe: this.dmRequestsInitiatedByMe,
      getPeerId: () => this.peerId,
      requireIdentity: () => this.requireIdentity(),
      requireTransport: () => this.requireTransport(),
      deliveryEngine: this.deliveryEngine,
    });

    this.agentRegistry = new AgentRegistry({
      agents: this.agents,
      identityCache: this.identityCache,
      startedAt: this.startedAt,
      getPeerId: () => this.peerId,
      requireTransport: () => this.requireTransport(),
      deliveryEngine: this.deliveryEngine,
    });

    this.connectionApproval = new ConnectionApproval({
      agents: this.agents,
      peerInfo: this.peerInfo,
      startedAt: this.startedAt,
      getPeerId: () => this.peerId,
      requireTransport: () => this.requireTransport(),
      getOnDelivery: () => this.onDelivery,
      queueDelivery: (agentId, event) => {
        this.deliveryEngine.queueDelivery(agentId, event);
      },
    });

    this.capabilityAskAdmission = new CapabilityAskAdmission({
      getPeerId: () => this.peerId,
      getOnDelivery: () => this.onDelivery,
      queueDelivery: (agentId, event) => {
        this.deliveryEngine.queueDelivery(agentId, event);
      },
    });

    this.staleAgentChecker = new StaleAgentChecker({
      agents: this.agents,
      deliveryQueues: this.deliveryQueues,
      identityCache: this.identityCache,
      peerInfo: this.peerInfo,
      notifyRoomsOfStatus: async (agentId, status) =>
        this.deliveryEngine.notifyRoomsOfStatus(agentId, status),
      broadcastPatch: async (patch) =>
        this.deliveryEngine.broadcastPatch(patch),
    });

    this.coordinatorGateway = new CoordinatorGateway({
      hubUrl: this.hubUrl,
      connectHub: async (url) => {
        await this.requireTransport().connectHub?.(url);
      },
      disconnectHub: async () => {
        await this.requireTransport().disconnectHub?.();
      },
      onError: (error) => {
        this.onError?.(error);
      },
    });

    this.peerLifecycle = new PeerLifecycle({
      peerInfo: this.peerInfo,
      agents: this.agents,
      coordinatorPort: this.coordinatorPort,
      getPeerId: () => this.peerId,
      requireTransport: () => this.requireTransport(),
      serialise: () => this.serialise(),
      roomProtocol: this.roomProtocol,
      deliveryEngine: this.deliveryEngine,
      staleAgentChecker: this.staleAgentChecker,
      coordinatorGateway: this.coordinatorGateway,
      onCoordinatorRoleChanged: async () => {
        await this.onCoordinatorRoleChanged?.(true);
      },
    });
  }

  /** Sets the transport (e.g. WireMeshTransport for encrypted connections). Must be called before init() or any other transport-using method. */
  setTransport(transport: Readonly<MeshTransport>): void {
    this.transport = transport;
  }

  /** The set transport, or throws if setTransport() hasn't been called yet -- the single place every transport-using method reads through, so the "must call setTransport() first" contract is enforced at one boundary rather than checked ad hoc at each call site. */
  private requireTransport(): MeshTransport {
    if (this.transport === undefined) {
      throw new Error(
        "MeshStore: no transport set; call setTransport() before using the store",
      );
    }
    return this.transport;
  }

  /** Sets the identity/clock/slot this store mints and persists room-membership grants against. Must be called before createRoom() or any other identity-using method, mirroring setTransport()'s own contract. */
  setIdentity(identity: MeshStoreIdentity): void {
    this.storeIdentity = identity;
  }

  /** The set identity, or throws if setIdentity() hasn't been called yet -- the single place every identity-using method reads through, mirroring requireTransport() above. */
  private requireIdentity(): MeshStoreIdentity {
    if (this.storeIdentity === undefined) {
      throw new Error(
        "MeshStore: no identity set; call setIdentity() before using the store",
      );
    }
    return this.storeIdentity;
  }

  // -----------------------------------------------------------------------
  // Mesh lifecycle
  // -----------------------------------------------------------------------

  async init(): Promise<void> {
    if (this.initialised) return;
    this.initialised = true;
    await this.requireTransport().startDataServer();

    // Register our own peer info
    this.peerInfo.set(this.peerId, {
      id: this.peerId,
      port: this.requireTransport().dataPort,
      startedAt: this.startedAt,
    });

    // Try joining an existing mesh; fall back to becoming coordinator.
    //
    // Single attempt: connect to an existing coordinator, or become one. If the coordinator port is occupied but unresponsive (e.g. an orphan process from a previous session), degrade gracefully instead of retrying. Retrying tls.connect after a failed handshake to a non-TLS endpoint can freeze the event loop (Node.js TLS session cache bug), so we only try once.
    let connected = false;

    try {
      await this.requireTransport().connectToCoordinator(
        COORDINATOR_HOST,
        this.coordinatorPort,
        this.peerId,
        this.requireTransport().dataPort,
      );
      connected = true;
    } catch {
      let eaddrinuseMessage: string | undefined;
      try {
        await this.requireTransport().becomeCoordinator(
          COORDINATOR_HOST,
          this.coordinatorPort,
        );
        this.staleAgentChecker.start();
        await this.coordinatorGateway.onBecameCoordinator();
        await this.onCoordinatorRoleChanged?.(true);
        connected = true;
      } catch (coordErr) {
        const msg =
          coordErr instanceof Error ? coordErr.message : String(coordErr);
        if (!msg.includes("EADDRINUSE")) {
          throw coordErr;
        }
        // EADDRINUSE — connectToCoordinator already failed above, so whatever holds this port never answered as a reachable coordinator either. Degrade, naming the actual mismatch rather than a generic "unavailable".
        eaddrinuseMessage = msg;
      }

      if (!connected) {
        this.events.onError?.(
          new Error(
            `MeshStore: could not join or create a mesh on port ${String(this.coordinatorPort)}. ` +
              `port ${String(this.coordinatorPort)} is already in use by something that never answered as a reachable coordinator -- a stale process from a previous run, or an incompatible agent-comms version. ` +
              "agent-comms will run without mesh connectivity until this is resolved. " +
              `(${eaddrinuseMessage ?? "unknown reason"})`,
          ),
        );
        return;
      }
    }

    this.requireTransport().unref();
  }

  // -----------------------------------------------------------------------
  // Transport events accessor (for bridges to wire up)
  // -----------------------------------------------------------------------

  /** Returns the TransportEvents object that bridges should pass to the transport constructor. */
  get events(): TransportEvents {
    return {
      onMessage: (handle, msg) => {
        void this.peerLifecycle.handleDataMessage(handle, msg);
      },
      onPeerConnected: (handle, info) => {
        void this.peerLifecycle.handlePeerConnected(handle, info);
      },
      onPeerDisconnected: (handle) => {
        this.peerLifecycle.handlePeerDisconnected(handle);
      },
      onIntroduction: (handle, msg) => {
        void this.peerLifecycle.handleIntroduction(handle, msg);
      },
      onPeerList: (peers) => {
        this.peerLifecycle.handlePeerList(peers);
      },
      onPeerJoined: (peer) => {
        this.peerLifecycle.handlePeerJoined(peer);
      },
      onBecomeCoordinator: (peerList) => {
        void this.peerLifecycle.handleBecomeCoordinator(peerList);
      },
      onConnectionRequest: (handle, request) => {
        this.connectionApproval.handleConnectionRequest(handle, request);
      },
      onError: (error) => {
        this.onError?.(error);
      },
      onRevocationAnnounce: (entry) => {
        void this.deliveryEngine.handleRevocationAnnounce(entry);
      },
      onPresenceAdvert: (handle, status) => {
        this.deliveryEngine.handlePresenceAdvert(handle.id, status);
      },
    };
  }

  /**
   * Room verb handlers this store registers with its own WireMeshTransport, keyed by params.verb per room-router.ts's own dispatch discipline.
   */
  get roomVerbHandlers(): Partial<Record<string, RoomVerbHandler>> {
    return this.roomProtocol.roomVerbHandlers;
  }

  // -----------------------------------------------------------------------
  // CommsStore — Identity
  // -----------------------------------------------------------------------

  async readIdentity(
    harness: string,
    cwd: string,
  ): Promise<{ id: string } | undefined> {
    return this.agentRegistry.readIdentity(harness, cwd);
  }

  async writeIdentity(harness: string, cwd: string, id: string): Promise<void> {
    return this.agentRegistry.writeIdentity(harness, cwd, id);
  }

  // -----------------------------------------------------------------------
  // CommsStore — Agent registry
  // -----------------------------------------------------------------------

  async registerAgent(opts: {
    name: string;
    harness: string;
    cwd: string;
    pid: number;
    visibility: Visibility;
    tags: string[];
  }): Promise<AgentIdentity> {
    return this.agentRegistry.registerAgent(opts);
  }

  async getAgent(id: string): Promise<AgentIdentity | undefined> {
    return this.agentRegistry.getAgent(id);
  }

  async updateAgent(
    id: string,
    patch: Partial<
      Pick<AgentIdentity, "name" | "visibility" | "status" | "tags" | "pid">
    >,
  ): Promise<AgentIdentity> {
    return this.agentRegistry.updateAgent(id, patch);
  }

  async listAgents(requesterId: string): Promise<AgentIdentity[]> {
    return this.agentRegistry.listAgents(requesterId);
  }

  async setAgentOffline(id: string): Promise<void> {
    return this.agentRegistry.setAgentOffline(id);
  }

  // -----------------------------------------------------------------------
  // CommsStore — Rooms
  // -----------------------------------------------------------------------

  async createRoom(
    opts: Readonly<{
      name: string;
      type: RoomType;
      owner: string;
      description: string;
    }>,
  ): Promise<Room> {
    return this.roomLifecycle.createRoom(opts);
  }

  async getRoom(id: string): Promise<Room | undefined> {
    return this.roomLifecycle.getRoom(id);
  }

  async listRooms(requesterId: string): Promise<Room[]> {
    return this.roomLifecycle.listRooms(requesterId);
  }

  /** Refreshes this store's own local copy of a named room's membership and room-state via a real room.members request (P3.6). Concrete-only -- reached directly by tests. */
  async refreshRoomMembers(roomPath: string): Promise<Room> {
    return this.roomLifecycle.refreshRoomMembers(roomPath);
  }

  /** The requester's own half of section 6's two-round DM consent flow, optionally presenting a dm:send grant (agent-comms#162) the counterpart's own user principal already minted for this device via admitAgentForDm -- when given and valid, the counterpart auto-admits immediately rather than holding the request open for a human decision. Deliberately outside the CommsStore interface, like connection approval, since it is a wire-mesh-specific concern FileStore has no equivalent for. Concrete-only -- reached directly by tests. */
  async requestDmAccess(
    counterpart: string,
    dmSendGrant?: CapabilityToken,
  ): Promise<void> {
    return this.roomLifecycle.requestDmAccess(counterpart, dmSendGrant);
  }

  /** Admits bearerId into this user's own DM-communication scope (agent-comms#162): mints and persists a dm:send grant, self-signed by this store's own user principal. Returns the minted token for the caller to deliver to bearerId out of band. Deliberately outside the CommsStore interface, like requestDmAccess above. Concrete-only -- reached directly by tests. delegationsRemaining defaults to 0 (non-delegable, the original behaviour); a positive value admits bearerId as a user principal capable of sub-delegating to its own devices (agent-comms#187) -- see RoomLifecycle.admitAgentForDm's own doc comment. */
  async admitAgentForDm(
    bearerId: string,
    delegationsRemaining = 0,
  ): Promise<CapabilityToken> {
    return this.roomLifecycle.admitAgentForDm(bearerId, delegationsRemaining);
  }

  /** Revokes bearerId's own dm:send grant for real (agent-comms#162), the DM-scope counterpart to kickFromRoom. A no-op if bearerId was never admitted. Deliberately outside the CommsStore interface, like requestDmAccess above. Concrete-only -- reached directly by tests. */
  async revokeAgentDmAccess(bearerId: string): Promise<void> {
    return this.roomLifecycle.revokeAgentDmAccess(bearerId);
  }

  async joinRoom(roomId: string, agentId: string): Promise<Room> {
    return this.roomLifecycle.joinRoom(roomId, agentId);
  }

  async leaveRoom(roomId: string, agentId: string): Promise<void> {
    return this.roomLifecycle.leaveRoom(roomId, agentId);
  }

  async inviteToRoom(
    roomId: string,
    targetId: string,
    inviterId: string,
  ): Promise<void> {
    return this.roomLifecycle.inviteToRoom(roomId, targetId, inviterId);
  }

  async declineInvite(
    roomId: string,
    agentId: string,
    reason: string,
  ): Promise<void> {
    return this.roomLifecycle.declineInvite(roomId, agentId, reason);
  }

  async kickFromRoom(
    roomId: string,
    targetId: string,
    kickerId: string,
  ): Promise<void> {
    return this.roomLifecycle.kickFromRoom(roomId, targetId, kickerId);
  }

  async destroyRoom(roomId: string, agentId: string): Promise<void> {
    return this.roomLifecycle.destroyRoom(roomId, agentId);
  }

  // -----------------------------------------------------------------------
  // CommsStore — Messages
  // -----------------------------------------------------------------------

  async sendRoomMessage(
    roomId: string,
    from: string,
    content: string,
    options?: SendRoomMessageOptions,
  ): Promise<RoomMessage> {
    return this.roomMessaging.sendRoomMessage(roomId, from, content, options);
  }

  async readRoomMessages(
    roomId: string,
    since?: string,
  ): Promise<RoomMessage[]> {
    return this.roomMessaging.readRoomMessages(roomId, since);
  }

  // -----------------------------------------------------------------------
  // CommsStore — DMs
  // -----------------------------------------------------------------------

  async sendDm(
    from: string,
    to: string,
    content: string,
    streamingBehavior?: StreamingBehavior,
  ): Promise<DmMessage> {
    return this.roomMessaging.sendDm(from, to, content, streamingBehavior);
  }

  // -----------------------------------------------------------------------
  // CommsStore — Delivery
  // -----------------------------------------------------------------------

  async deliver(agentId: string, event: DeliveryEvent): Promise<void> {
    return this.deliveryEngine.deliver(agentId, event);
  }

  async drainDelivery(agentId: string): Promise<DeliveryEvent[]> {
    return this.deliveryEngine.drainDelivery(agentId);
  }

  // -----------------------------------------------------------------------
  // Concrete-only surface reached directly by tests
  // -----------------------------------------------------------------------

  /** Merge a peer's state snapshot into the local state (#27/#28). Concrete-only -- reached directly by tests. */
  applyStateSync(state: SerialisedState): void {
    this.deliveryEngine.applyStateSync(state);
  }

  /** Sends one directed room.send to a single member's own session (P3.5). Concrete-only -- reached directly by tests. */
  async sendRoomMessageDirected(
    roomPath: string,
    memberId: string,
    text: string,
  ): Promise<void> {
    return this.roomProtocol.sendRoomMessageDirected(roomPath, memberId, text);
  }

  /** Starts only the data server without connecting to a coordinator. Used for testing scenarios where the peer connects via connectToRemote. */
  async startDataServerOnly(): Promise<void> {
    return this.connectionApproval.startDataServerOnly();
  }

  // -----------------------------------------------------------------------
  // Connection approval (mesh-only)
  // -----------------------------------------------------------------------

  /** Accept a pending inbound connection. */
  async acceptConnection(connectionId: string): Promise<void> {
    return this.connectionApproval.acceptConnection(connectionId);
  }

  /** Reject a pending inbound connection. */
  async rejectConnection(connectionId: string, reason: string): Promise<void> {
    return this.connectionApproval.rejectConnection(connectionId, reason);
  }

  /** List all pending inbound connections awaiting approval. */
  listPendingConnections(): {
    connectionId: string;
    peerId: string;
    dataPort: number;
    name: string;
    fingerprint: string;
  }[] {
    return this.connectionApproval.listPendingConnections();
  }

  /** Initiate an outbound connection to a remote coordinator requiring approval. */
  async connectToRemote(host: string, port: number): Promise<void> {
    return this.connectionApproval.connectToRemote(host, port);
  }

  // -----------------------------------------------------------------------
  // Room-join approval (mesh-only)
  // -----------------------------------------------------------------------

  /** Every room.join request currently held open awaiting this store's own accept/reject decision. */
  listPendingRoomJoins(): { roomPath: string; requesterId: string }[] {
    return this.roomProtocol.listPendingRoomJoins();
  }

  /** Approves a pending room.join request. */
  acceptRoomJoin(roomPath: string, requesterId: string): void {
    this.roomProtocol.acceptRoomJoin(roomPath, requesterId);
  }

  /** Denies a pending room.join request, optionally with a reason. */
  rejectRoomJoin(roomPath: string, requesterId: string, reason?: string): void {
    this.roomProtocol.rejectRoomJoin(roomPath, requesterId, reason);
  }

  // -----------------------------------------------------------------------
  // Capability-request ask tier (mesh-only, agent-comms#165)
  // -----------------------------------------------------------------------

  /** Builds a manage-request handler surfacing one capability's incoming capability-requests as held-open asks (agent-comms#165's own tool-layer surface for the ask tier) -- the registration point a capability-gated verb (e.g. agent-comms#162's dm:send) wires into its own session dispatch, backed by this store's identity/clock and this admission's live pending state. */
  createCapabilityAskHandler(
    options: Readonly<{
      capability: string;
      bearerDevice: DeviceId;
      timeoutMs: number;
    }>,
  ): (incoming: Readonly<IncomingManageRequest>) => Promise<void> {
    const { identity, clock } = this.requireIdentity();
    return this.capabilityAskAdmission.createAskHandler({
      capability: options.capability,
      identity,
      clock,
      bearerDevice: options.bearerDevice,
      timeoutMs: options.timeoutMs,
    });
  }

  /** Every capability-request currently held open awaiting this store's own accept/reject decision. */
  listPendingCapabilityRequests(): {
    requestId: string;
    capability: string;
    scopeKind: string;
    scopePath?: string;
    requesterDevice: string;
  }[] {
    return this.capabilityAskAdmission.listPendingCapabilityRequests();
  }

  /** Approves a pending capability request, minting and returning the granted token. */
  async acceptCapabilityRequest(
    requestId: string,
    options: Readonly<{
      expires: number;
      delegationsRemaining?: number;
      capability?: string;
    }>,
  ): Promise<void> {
    await this.capabilityAskAdmission.acceptCapabilityRequest(
      requestId,
      options,
    );
  }

  /** Denies a pending capability request, optionally with a reason. */
  async rejectCapabilityRequest(
    requestId: string,
    reason?: string,
  ): Promise<void> {
    await this.capabilityAskAdmission.rejectCapabilityRequest(
      requestId,
      reason,
    );
  }

  // -----------------------------------------------------------------------
  // Mesh visibility
  // -----------------------------------------------------------------------

  /** Set mesh discovery visibility. Delegates to discovery manager. */
  async setVisibility(level: MeshVisibility, adapter?: string): Promise<void> {
    await this.discovery.setVisibility(level, adapter);
  }

  /** Get current mesh discovery visibility. */
  getVisibility(adapter?: string): MeshVisibility {
    return this.discovery.getVisibility(adapter);
  }

  // -----------------------------------------------------------------------
  // Gateway trust (agent-comms#156) -- the cross-machine trust boundary
  // -----------------------------------------------------------------------

  /** Trusts a remote device-id (hex): this store's own gateway (once it becomes the coordinator) will advertise onto the hub, merge this device's gossiped directory entries, dispatch its relayed requests, and route outbound hub requests to it. See GatewayTrust's own class doc for why trust is keyed per device-id rather than per remote machine, and why it doesn't survive a restart. */
  addTrustedGateway(deviceHex: string): void {
    this.gatewayTrust.add(deviceHex);
  }

  /** Withdraws trust from a remote device-id (hex). A no-op if it was never trusted. */
  removeTrustedGateway(deviceHex: string): void {
    this.gatewayTrust.remove(deviceHex);
  }

  /** Every currently trusted remote device-id (hex). */
  listTrustedGateways(): string[] {
    return this.gatewayTrust.list();
  }

  /** Trusts a remote user-principal device-id (hex, agent-comms#187): a peer presenting a token whose delegation chain roots at this principal is trusted via GatewayTrust.isTrustedFor, without its own bare device-id ever needing individual trust. Entirely independent of the bare-device allowlist addTrustedGateway manages. */
  addTrustedGatewayPrincipal(deviceHex: string): void {
    this.gatewayTrust.addPrincipal(deviceHex);
  }

  /** Withdraws trust from a remote user-principal device-id (hex). A no-op if it was never trusted. */
  removeTrustedGatewayPrincipal(deviceHex: string): void {
    this.gatewayTrust.removePrincipal(deviceHex);
  }

  /** Every currently trusted remote user-principal device-id (hex). */
  listTrustedGatewayPrincipals(): string[] {
    return this.gatewayTrust.listPrincipals();
  }

  // -----------------------------------------------------------------------
  // Connection codes (agent-comms#188) -- bootstrapping gateway trust with no existing mesh connection between the two devices
  // -----------------------------------------------------------------------

  /** Generates a fresh single-use ConnectionCode vouching for this store's own device-id (peerId), for the operator to relay to a counterpart out of band. See ConnectionCodeLedger.generate's own doc comment for what options does. */
  async generateConnectionCode(
    options: Readonly<GenerateConnectionCodeOptions> = {},
  ): Promise<ConnectionCode> {
    return this.connectionCodes.generate(this.peerId, options);
  }

  /** Validates a candidate ConnectionCode (see ConnectionCodeLedger.redeem for the checks performed) and, only once it passes every check, trusts the device-id it vouches for via gatewayTrust.add -- the actual point of this whole bootstrap. A rejected candidate never reaches gatewayTrust at all. */
  async redeemConnectionCode(
    candidate: Readonly<ConnectionCode>,
    options: Readonly<RedeemConnectionCodeOptions> = {},
  ): Promise<RedeemConnectionCodeResult> {
    const result = await this.connectionCodes.redeem(candidate, options);
    this.gatewayTrust.add(result.deviceId);
    return result;
  }

  // -----------------------------------------------------------------------
  // Listener management (coordinator only)
  // -----------------------------------------------------------------------

  async addListener(
    host: string,
    port: number,
    policy: string,
  ): Promise<string> {
    function isListenerPolicy(v: string): v is ListenerPolicy {
      return (
        v === "full" || v === "observe" || v === "rooms-only" || v === "gateway"
      );
    }
    if (!isListenerPolicy(policy)) {
      throw new CommsError(`Invalid policy "${policy}"`, "INVALID_POLICY");
    }
    return this.requireTransport().addListener(host, port, policy);
  }

  async removeListener(id: string): Promise<void> {
    return this.requireTransport().removeListener(id);
  }

  listListeners(): ListenerInfo[] {
    return this.requireTransport().listListeners();
  }

  /** Delegates to the transport's own meshGraph, throwing if the current transport doesn't support it (agent-comms#199) -- CommsTool's own notMeshBacked distinguishes "no MeshStore at all" from this narrower "MeshStore, but a transport without this capability" case by catching the throw, the same way requireTransport's own "no transport set" throw is already handled. */
  meshGraph(): MeshGraph {
    const graph = this.requireTransport().meshGraph?.();
    if (graph === undefined) {
      throw new CommsError(
        "mesh_graph requires a transport that supports it",
        "NOT_SUPPORTED",
      );
    }
    return graph;
  }

  /** Delegates to the transport's own meshTrace, same "throw if unsupported" contract as meshGraph above. */
  async meshTrace(
    target: string,
    timeoutMs?: number,
  ): Promise<MeshTraceResult> {
    const transport = this.requireTransport();
    if (transport.meshTrace === undefined) {
      throw new CommsError(
        "mesh_trace requires a transport that supports it",
        "NOT_SUPPORTED",
      );
    }
    return transport.meshTrace(target, timeoutMs);
  }

  getNetworkInterfaces(): NetworkInterface[] {
    const interfaces = os.networkInterfaces();
    const result: NetworkInterface[] = [];
    for (const [name, addrs] of Object.entries(interfaces)) {
      if (addrs === undefined) continue;
      for (const addr of addrs) {
        result.push({
          name,
          address: addr.address,
          family: addr.family,
          internal: addr.internal,
        });
      }
    }
    return result;
  }

  // -----------------------------------------------------------------------
  // Peer versions (agent-comms#198) -- the cached, gossip-backed path
  // -----------------------------------------------------------------------

  /** deviceId's own gossiped agent-comms package version, if this side has heard it advertised -- undefined for a device this side has never heard gossip from, or one running a version of agent-comms that predates this feature. */
  getPeerAgentCommsVersion(deviceId: string): string | undefined {
    return getPeerAgentCommsVersions(this.requireTransport(), deviceId)
      ?.agentComms;
  }

  /** deviceId's own gossiped cc-peer package version, present only while that device is actually fronting a cc-peer session or running the one-shot `bridge cc-peer` command -- undefined otherwise, or for a device this side has never heard gossip from. */
  getPeerCcPeerVersion(deviceId: string): string | undefined {
    return getPeerAgentCommsVersions(this.requireTransport(), deviceId)?.ccPeer;
  }

  /** deviceId's own gossiped wire-mesh-core version, self-advertised automatically by wire-mesh-core itself (wire-mesh#179) -- undefined for a device this side has never heard gossip from, or one running a wire-mesh-core older than #179. */
  getPeerWireMeshCoreVersion(deviceId: string): string | undefined {
    return getPeerWireMeshCoreVersion(this.requireTransport(), deviceId);
  }

  // -----------------------------------------------------------------------
  // Peer versions (agent-comms#198) -- the live, cache-busting path
  // -----------------------------------------------------------------------

  /** Asks deviceId for its own, currently-running wire-mesh-core version live, right now, rather than trusting whatever it last gossiped -- the query_version action's own backing call. Resolves to a plain, provider-neutral result rather than leaking wire-mesh-core's own ManageOutcome type up to CommsTool, which has no other reason to know that type exists. */
  async queryVersion(
    deviceId: string,
  ): Promise<{ version: string } | { error: string }> {
    const transport = this.requireTransport();
    if (transport.queryVersion === undefined) {
      return {
        error: "this transport does not support querying a peer's version",
      };
    }
    const outcome: ManageOutcome = await transport.queryVersion(deviceId);
    if (outcome.result === "error") {
      return { error: outcome.message ?? outcome.code };
    }
    const version: unknown = outcome.version;
    if (typeof version !== "string") {
      return { error: "peer answered version.get with no version string" };
    }
    return { version };
  }

  // -----------------------------------------------------------------------
  // Shutdown
  // -----------------------------------------------------------------------

  async shutdown(): Promise<void> {
    this.isShutDown = true;
    // Clear any pending markRead timers so they don't fire after the transport is shut down (which would attempt sends on closed sockets) or keep the event loop alive after process.exit().
    for (const timer of this.pendingMarkReadTimers) {
      clearTimeout(timer);
    }
    this.pendingMarkReadTimers.length = 0;

    const agent = this.agents.get(this.peerId);
    if (agent) {
      agent.status = "offline";
      await this.deliveryEngine.broadcastPatch({
        type: "agent_offline",
        agentId: this.peerId,
      });
    }

    this.staleAgentChecker.stop();
    await this.coordinatorGateway.onLostCoordinator();
    // Graceful coordinator handover (agent-comms#170) -- a no-op unless this side currently holds the coordinator role, so this runs unconditionally rather than being gated behind an isCoordinator check duplicated here. Must run before the transport shuts down: the handoff message rides the very peer sessions shutdown() is about to close.
    await this.peerLifecycle.sendCoordinatorHandover();
    await this.onCoordinatorRoleChanged?.(false);
    await this.requireTransport().shutdown();
  }
}

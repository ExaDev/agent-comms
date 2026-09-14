/**
 * MeshStore — transport-agnostic peer mesh for agent communication.
 *
 * Each bridge instance is a peer in the mesh. Peers discover each other via a coordinator (the first instance to bind the well-known port). All state is held in memory and synchronised between peers. Delivery events are pushed directly over the transport — no polling, no filesystem.
 *
 * Transport is set via setTransport() (e.g. WireMeshTransport for encrypted connections) before init() or any other transport-using method is called -- there is no default, since every real bridge builds its own transport from this store's own events getter, which needs the store to already exist.
 *
 * MeshStore itself is an orchestrator: it owns the shared state (the core agents/rooms/messages/dms/deliveryQueues Maps and a handful of smaller fields) and constructs the collaborators that implement almost every behaviour against direct references into that state -- DeliveryEngine, FederationBridge, RoomProtocol, RoomMessaging, RoomLifecycle, AgentRegistry, ConnectionApproval, StaleAgentChecker, and PeerLifecycle. Every public method below that isn't inherently a MeshStore-level concern (transport/identity wiring, init/shutdown lifecycle, the events getter, mesh visibility, listener management, federation-adapter passthroughs) is a thin delegating wrapper to whichever collaborator now owns the real implementation, kept here only because CommsStore/MeshOnlyFeatures and a handful of concrete-only call sites (tests, bridge-mesh.ts, the web server, etc.) reach these names directly on a MeshStore-typed value.
 */

import * as os from "node:os";
import { nanoid } from "./nanoid.js";
import { CommsError } from "./store.js";
import { DiscoveryManager } from "./discovery.js";
import { MdnsDiscoveryBackend } from "./discovery-mdns.js";
import { TailscaleDiscoveryBackend } from "./discovery-tailscale.js";
import { FederationManager } from "./federation.js";
import type { FedLink } from "./federation.js";
import { getCertificateFingerprint } from "./identity.js";
import { COORDINATOR_HOST } from "./mesh-store-shared.js";
import type { MeshStoreIdentity } from "./mesh-store-shared.js";
import { DeliveryEngine } from "./delivery-engine.js";
import { FederationBridge } from "./federation-bridge.js";
import { RoomProtocol } from "./room-protocol.js";
import { RoomMessaging } from "./room-messaging.js";
import { RoomLifecycle } from "./room-lifecycle.js";
import { AgentRegistry } from "./agent-registry.js";
import { ConnectionApproval } from "./connection-approval.js";
import { StaleAgentChecker } from "./stale-agent-checker.js";
import { PeerLifecycle } from "./peer-lifecycle.js";
import type { RoomVerbHandler } from "./room-router.js";
import type {
  MeshStatePatch,
  PeerInfo,
  SerialisedState,
} from "./wire-protocol.js";
import type {
  ListenerInfo,
  ListenerPolicy,
  MeshTransport,
  TransportEvents,
} from "./transport.js";
import type { CommsStore } from "./comms-store.js";
import type {
  AgentIdentity,
  AgentStatus,
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

export class MeshStore implements CommsStore {
  peerId: string;
  readonly startedAt: string;
  readonly coordinatorPort: number;

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
  federation: FederationManager;

  private readonly deliveryEngine: DeliveryEngine;
  private readonly federationBridge: FederationBridge;
  private readonly roomProtocol: RoomProtocol;
  private readonly roomMessaging: RoomMessaging;
  private readonly roomLifecycle: RoomLifecycle;
  private readonly agentRegistry: AgentRegistry;
  private readonly connectionApproval: ConnectionApproval;
  private readonly staleAgentChecker: StaleAgentChecker;
  private readonly peerLifecycle: PeerLifecycle;

  /** This store's own current AgentStatus, synchronously -- the value WireMeshTransport's presence re-advertisement timer reads on every tick. undefined before registerAgent has ever run (no self agent record exists yet), in which case there is nothing yet to advertise. */
  get selfStatus(): AgentStatus | undefined {
    return this.agents.get(this.peerId)?.status;
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

  constructor(coordinatorPort: number = DEFAULT_COORDINATOR_PORT) {
    this.peerId = nanoid(PEER_ID_LENGTH);
    this.startedAt = new Date().toISOString();
    this.coordinatorPort = coordinatorPort;

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
      // RoomProtocol doesn't exist yet at this point in the constructor -- this closure resolves `this.roomProtocol` lazily, only once markRead actually calls it at runtime, well after the constructor has finished. Mirrors the lazy-`this`-capture pattern FederationManager's own callbacks use below.
      sendRoomRequestToMember: async (memberId, roomPath, token, params) =>
        this.roomProtocol.sendRoomRequestToMember(
          memberId,
          roomPath,
          token,
          params,
        ),
    });

    this.federationBridge = new FederationBridge({
      agents: this.agents,
      rooms: this.rooms,
      messages: this.messages,
      deliveryEngine: this.deliveryEngine,
    });

    // Federation manager — coordinator-to-coordinator links
    this.federation = new FederationManager(
      this.peerId, // mesh ID is the coordinator's peer ID
      `mesh-${this.peerId}`,
      this.federationBridge,
    );

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
      // RoomLifecycle doesn't exist yet at this point -- deferred the same way DeliveryEngine's sendRoomRequestToMember closure above is.
      revokeMemberGrant: async (roomId, memberId) =>
        this.roomLifecycle.revokeMemberGrant(roomId, memberId),
    });

    this.roomMessaging = new RoomMessaging({
      rooms: this.rooms,
      messages: this.messages,
      dms: this.dms,
      agents: this.agents,
      requireIdentity: () => this.requireIdentity(),
      roomProtocol: this.roomProtocol,
      federation: this.federation,
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
      federation: this.federation,
    });

    this.agentRegistry = new AgentRegistry({
      agents: this.agents,
      identityCache: this.identityCache,
      startedAt: this.startedAt,
      getPeerId: () => this.peerId,
      deliveryEngine: this.deliveryEngine,
      federation: this.federation,
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
      try {
        await this.requireTransport().becomeCoordinator(
          COORDINATOR_HOST,
          this.coordinatorPort,
        );
        this.staleAgentChecker.start();
        connected = true;
      } catch (coordErr) {
        const msg =
          coordErr instanceof Error ? coordErr.message : String(coordErr);
        if (!msg.includes("EADDRINUSE")) {
          throw coordErr;
        }
        // EADDRINUSE — port held by an unresponsive process. Degrade.
      }
    }

    if (!connected) {
      this.events.onError?.(
        new Error(
          `MeshStore: could not join or create mesh on port ${String(this.coordinatorPort)}. ` +
            "Running without mesh — agent-comms will be unavailable.",
        ),
      );
      return;
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
      federated?: boolean;
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

  /** The requester's own half of section 6's two-round DM consent flow. Deliberately outside the CommsStore interface, like connection approval, since it is a wire-mesh-specific concern FileStore has no equivalent for. Concrete-only -- reached directly by tests. */
  async requestDmAccess(counterpart: string): Promise<void> {
    return this.roomLifecycle.requestDmAccess(counterpart);
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
    replyTo?: string,
    streamingBehavior?: StreamingBehavior,
  ): Promise<RoomMessage> {
    return this.roomMessaging.sendRoomMessage(
      roomId,
      from,
      content,
      replyTo,
      streamingBehavior,
    );
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
  // Federation (coordinator-to-coordinator)
  // -----------------------------------------------------------------------

  async fedConnect(host: string, port: number, name?: string): Promise<string> {
    return this.federation.connect(host, port, name);
  }

  async fedDisconnect(linkId: string): Promise<void> {
    await this.federation.disconnect(linkId);
  }

  fedLinks(): FedLink[] {
    return this.federation.listLinks();
  }

  getFederationFingerprint(): string {
    return getCertificateFingerprint(this.federation.tlsIdentity.certificate);
  }

  async fedTrust(fingerprint: string): Promise<void> {
    this.federation.addTrustedFingerprint(fingerprint);
    return Promise.resolve();
  }

  async fedUntrust(fingerprint: string): Promise<void> {
    this.federation.removeTrustedFingerprint(fingerprint);
    return Promise.resolve();
  }

  fedTrustedFingerprints(): string[] {
    return this.federation.listTrustedFingerprints();
  }

  async fedListen(host: string, port: number): Promise<void> {
    return this.federation.listen(host, port);
  }

  async fedStopListening(): Promise<void> {
    return this.federation.stopListening();
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
    await this.federation.shutdown();
    await this.requireTransport().shutdown();
  }
}

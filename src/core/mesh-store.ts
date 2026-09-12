/**
 * MeshStore — transport-agnostic peer mesh for agent communication.
 *
 * Each bridge instance is a peer in the mesh. Peers discover each other
 * via a coordinator (the first instance to bind the well-known port).
 * All state is held in memory and synchronised between peers.
 * Delivery events are pushed directly over the transport — no polling,
 * no filesystem.
 *
 * Transport is set via setTransport() (e.g. WireMeshTransport for encrypted
 * connections) before init() or any other transport-using method is called
 * -- there is no default, since every real bridge builds its own transport
 * from this store's own events getter, which needs the store to already
 * exist.
 */

import * as os from "node:os";
import { nanoid } from "./nanoid.js";
import { CommsError } from "./store.js";
import { normaliseWireState } from "./wire-protocol.js";
import {
  dmRoomPath,
  ownerNamedRoomPath,
  parseRoomPath,
  slugRoomName,
} from "./room-path.js";
import type { SerialisedState } from "./wire-protocol.js";
import { DiscoveryManager } from "./discovery.js";
import { MdnsDiscoveryBackend } from "./discovery-mdns.js";
import { TailscaleDiscoveryBackend } from "./discovery-tailscale.js";
import { FederationManager } from "./federation.js";
import type { FedLink } from "./federation.js";
import { getCertificateFingerprint } from "./identity.js";
import {
  bytesFromHex,
  bytesToHex,
  deviceIdFromHex,
  deviceIdToHex,
} from "wire-mesh-core/domain/device-id";
import {
  mintCapabilityToken,
  mintRevocationEntry,
} from "wire-mesh-core/domain/tokens";
import type { RevocationView } from "wire-mesh-core/domain/revocation-view";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import type { Clock } from "wire-mesh-core/ports/clock";
import type {
  IncomingManageRequest,
  ManageOutcome,
} from "wire-mesh-core/domain/mesh-session";
import {
  roomInviteSchema,
  roomJoinOkSchema,
  roomLeaveSchema,
  roomMembersOkSchema,
  roomReadSchema,
  roomSendSchema,
} from "wire-mesh-core/generated/protocol";
import type {
  CapabilityToken,
  MessageRef,
  RevocationEntry,
} from "wire-mesh-core/generated/protocol";
import type { RoomVerbHandler } from "./room-router.js";
import {
  ROOM_MEMBER_CAPABILITY,
  verifyRoomToken,
} from "./room-token-verification.js";
import {
  deleteIssuedRoomGrant,
  deleteRoomToken,
  loadIssuedRoomGrant,
  loadRoomTokens,
  saveIssuedRoomGrant,
  saveRoomToken,
} from "./identity-store.js";
import type { IdentitySlot } from "./identity-store.js";
import { randomId } from "./random-id.js";
import type { MeshMessage, MeshStatePatch, PeerInfo } from "./wire-protocol.js";
import type {
  ConnectionHandle,
  MeshTransport,
  TransportEvents,
} from "./transport.js";
import type { CommsStore } from "./comms-store.js";
import { RoomType, StreamingBehavior } from "./types.js";
import type {
  AgentIdentity,
  AgentStatus,
  DeliveryEvent,
  DeliveryStatus,
  DmMessage,
  MeshVisibility,
  NetworkInterface,
  Room,
  RoomMessage,
  Visibility,
} from "./types.js";
import type { ListenerInfo, ListenerPolicy } from "./transport.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_COORDINATOR_PORT = 19876;
const COORDINATOR_HOST = "127.0.0.1";

/** The identity/clock/persistence collaborators MeshStore mints and persists room-membership grants against. Set via setIdentity(), mirroring the transport's own setTransport() contract. */
export interface MeshStoreIdentity {
  identity: IdentityPort;
  clock: Clock;
  slot: IdentitySlot;
  revocation: RevocationView;
}

/**
 * Lifetime of a freshly minted room:member grant (owner root grant or member join/invite grant alike). Deliberately generous rather than the "short expires, periodic re-issue" pattern the design calls for to bound kick-convergence to gossip-independent expiry -- that re-issue mechanism is P3.7's own deliverable (riding room.members refreshes), and shipping a short expiry before it exists would let ordinary grants go stale with nothing to renew them. 30 days comfortably outlives any realistic room lifetime for now; P3.7 tightens this once re-issue-on-refresh lands.
 */
const ROOM_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/** A human's decision on a pending room.join request -- reject carries an optional reason, mirroring rejectConnection's own equivalent room-independent decision. */
type RoomJoinDecision =
  { kind: "accept" } | { kind: "reject"; reason?: string };

/**
 * Bound on pending delivery events held per target agent. Events beyond the
 * bound drop oldest-first: a long-offline agent's queue cannot grow without
 * limit in memory or in synced snapshots (#28).
 */
const MAX_QUEUED_DELIVERIES_PER_AGENT = 100;

/**
 * Merge an incoming append-only message history into the local one: add
 * entries the local list does not have and union read receipts on the ones
 * it does. Local ordering is preserved; unseen entries are appended.
 */
function mergeMessageHistories<T extends { id: string; readBy: string[] }>(
  local: T[],
  incoming: T[],
): void {
  const byId = new Map(local.map((m) => [m.id, m]));
  for (const msg of incoming) {
    const existing = byId.get(msg.id);
    if (existing === undefined) {
      local.push(msg);
      byId.set(msg.id, msg);
      continue;
    }
    for (const reader of msg.readBy) {
      if (!existing.readBy.includes(reader)) existing.readBy.push(reader);
    }
  }
}

// ---------------------------------------------------------------------------
// MeshStore
// ---------------------------------------------------------------------------

export class MeshStore implements CommsStore {
  peerId: string;
  readonly startedAt: string;
  readonly coordinatorPort: number;

  private agents = new Map<string, AgentIdentity>();
  private rooms = new Map<string, Room>();
  private messages = new Map<string, RoomMessage[]>();
  private dms = new Map<string, DmMessage[]>();
  private deliveryQueues = new Map<string, DeliveryEvent[]>();
  private identityCache = new Map<string, { id: string }>();
  /** Directed room-domain requests (room.send, room.read) that failed because their target member wasn't reachable at send time, held for retry when that member's own connection is (re)established -- the wire-authenticated fan-out's substitute for the legacy full-state-sync's own automatic eventual consistency, since a direct request to a disconnected peer fails immediately with no protocol-level retry of its own. Keyed by member device-id hex, bounded oldest-first per member with the same cap ordinary delivery queues use. */
  private pendingRoomRequests = new Map<
    string,
    { roomPath: string; params: Record<string, unknown> }[]
  >();

  private transport: MeshTransport | undefined;
  private storeIdentity: MeshStoreIdentity | undefined;
  private peerInfo = new Map<string, PeerInfo>();
  private staleCheckTimer: ReturnType<typeof setInterval> | undefined;
  private isShutDown = false;
  private initialised = false;
  private pendingMarkReadTimers: ReturnType<typeof setTimeout>[] = [];

  /** Whether the mesh has a live coordinator connection. */
  get connected(): boolean {
    return (
      this.requireTransport().isCoordinator ||
      this.requireTransport().hasCoordinatorConnection
    );
  }

  // -- Pending inbound connections awaiting approval --
  private pendingInboundConnections = new Map<
    string,
    { peerId: string; dataPort: number; name: string; fingerprint: string }
  >();

  // -- Pending room.join requests awaiting owner approval, keyed by `${roomPath}::${requesterId}` -- the held-open manage-request's own resolve() function is stored here so acceptRoomJoin/rejectRoomJoin can settle it in place, mirroring pendingInboundConnections' own pattern one layer up (room admission, not mesh admission).
  private pendingRoomJoins = new Map<
    string,
    {
      roomPath: string;
      requesterId: string;
      resolve: (decision: RoomJoinDecision) => void;
    }
  >();

  // -- DM paths this store has itself sent an outbound room.join for -- section 6's own basis for auto-approving the counterpart's reciprocal room.join without a second human decision. Never cleared: a DM conversation, once opened, stays open, and holding a stale entry here costs nothing beyond a few bytes per DM this node has ever initiated.
  private dmRequestsInitiatedByMe = new Set<string>();

  onDelivery:
    | ((agentId: string, event: DeliveryEvent) => void | Promise<void>)
    | undefined;

  /** Fires for every state patch — both locally generated and remote. */
  onPatch: ((patch: MeshStatePatch) => void | Promise<void>) | undefined;

  /**
   * Fires for a transport-level error a caller may want to observe (a connection rejected for presenting a certificate that doesn't match its claimed peer ID, this store's own inability to join or create a mesh, etc). Previously wired to `this.events.onError` inside this class's own methods, but the `events` getter never actually implemented `onError` on the object it returns, so every one of those calls was silently a no-op -- this store had no way to observe its own transport failures at all. Left undefined by default (matching onDelivery/onPatch): a caller that wants visibility sets it, exactly like those two.
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

  private lastLocalDeliveryKey: string | undefined;
  private localDeliveryKeys = new Set<string>();

  discovery: DiscoveryManager;
  federation: FederationManager;

  constructor(coordinatorPort: number = DEFAULT_COORDINATOR_PORT) {
    this.peerId = nanoid(8);
    this.startedAt = new Date().toISOString();
    this.coordinatorPort = coordinatorPort;

    // Discovery manager — registers available backends
    this.discovery = new DiscoveryManager();
    this.discovery.registerBackend(new MdnsDiscoveryBackend());
    this.discovery.registerBackend(new TailscaleDiscoveryBackend());

    // Federation manager — coordinator-to-coordinator links
    this.federation = new FederationManager(
      this.peerId, // mesh ID is the coordinator's peer ID
      `mesh-${this.peerId}`,
      {
        onAgentVisible: (agent) => this.handleFedAgentVisible(agent),
        onAgentGone: (agentId) => this.handleFedAgentGone(agentId),
        onRoomMessage: (roomId, message) =>
          this.handleFedRoomMessage(roomId, message),
        onRoomJoin: (roomId, agentId, agentName) =>
          this.handleFedRoomJoin(roomId, agentId, agentName),
        onRoomLeave: (roomId, agentId) =>
          this.handleFedRoomLeave(roomId, agentId),
        getVisibleAgents: () => this.getVisibleAgentsForFed(),
        getFederatedRoomMemberships: () =>
          this.getFederatedRoomMembershipsForFed(),
      },
    );
  }

  /** Sets the transport (e.g. WireMeshTransport for encrypted connections). Must be called before init() or any other transport-using method. */
  setTransport(transport: MeshTransport): void {
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
    // Single attempt: connect to an existing coordinator, or become one.
    // If the coordinator port is occupied but unresponsive (e.g. an orphan
    // process from a previous session), degrade gracefully instead of
    // retrying. Retrying tls.connect after a failed handshake to a
    // non-TLS endpoint can freeze the event loop (Node.js TLS session
    // cache bug), so we only try once.
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
        this.startStaleCheck();
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
  // TransportEvents — callbacks from the transport layer
  // -----------------------------------------------------------------------

  private handlePeerList(peers: PeerInfo[]): void {
    for (const peer of peers) {
      this.peerInfo.set(peer.id, peer);
      // The list always includes this store's own entry — dialling yourself is a wasted connection attempt (and, on some platforms, an immediate self-inflicted ECONNRESET) that never needs to happen.
      if (peer.id === this.peerId) continue;
      void this.requireTransport().connectToPeer(peer, this.peerId);
    }
  }

  private handlePeerJoined(peer: PeerInfo): void {
    this.peerInfo.set(peer.id, peer);
    if (peer.id === this.peerId) return;
    void this.requireTransport().connectToPeer(peer, this.peerId);
  }

  private async handleIntroduction(
    handle: ConnectionHandle,
    msg: { peerId: string; dataPort: number },
  ): Promise<void> {
    const newPeer: PeerInfo = {
      id: msg.peerId,
      port: msg.dataPort,
      startedAt: new Date().toISOString(),
    };
    this.peerInfo.set(msg.peerId, newPeer);

    // Send full peer list to the new peer
    const peerList: MeshMessage = {
      method: "peer_list",
      peers: [...this.peerInfo.values()],
    };
    await this.requireTransport().send(handle, peerList);

    // Broadcast arrival to all existing peers
    const joined: MeshMessage = { method: "peer_joined", peer: newPeer };
    await this.requireTransport().broadcast(joined);

    // Connect to the new peer's data server
    void this.requireTransport().connectToPeer(newPeer, this.peerId);
  }

  private async handlePeerConnected(
    handle: ConnectionHandle,
    _info: PeerInfo,
  ): Promise<void> {
    // If we have state and the peer doesn't, send state sync
    if (this.agents.size > 0) {
      const state: SerialisedState = this.serialise();
      await this.requireTransport().send(handle, {
        method: "state_sync",
        state,
      });
    }
    await this.flushPendingRoomRequests(handle.id);
  }

  /**
   * Merge a peer's state snapshot into the local state. Agents and rooms
   * accept the incoming copy when it carries a revision at least as high as
   * the local one, so a peer holding stale entities converges when it
   * receives a fresher snapshot, while its own stale copies are rejected by
   * peers that stayed current (#27). Message and DM histories are
   * append-only: add unseen entries and union read receipts.
   */
  applyStateSync(state: SerialisedState): void {
    const incoming = {
      agents: new Map(Object.entries(state.agents)),
      rooms: new Map(Object.entries(state.rooms)),
      messages: new Map(Object.entries(state.messages)),
      dms: new Map(Object.entries(state.dms)),
    };
    {
      for (const [id, agent] of incoming.agents) {
        const existingVersion = this.agents.get(id)?.version;
        if (existingVersion !== undefined && agent.version < existingVersion) {
          continue;
        }
        if (existingVersion === agent.version) {
          const existing = this.agents.get(id);
          if (existing) {
            for (const r of existing.subscribedRooms) {
              if (!agent.subscribedRooms.includes(r))
                agent.subscribedRooms.push(r);
            }
          }
        }
        this.agents.set(id, agent);
      }
      for (const [id, room] of incoming.rooms) {
        const existingVersion = this.rooms.get(id)?.version;
        if (existingVersion !== undefined && room.version < existingVersion) {
          continue;
        }
        this.mergeRoom(room);
      }
      for (const [id, msgs] of incoming.messages) {
        const existing = this.messages.get(id);
        if (existing === undefined) {
          this.messages.set(id, msgs);
          continue;
        }
        mergeMessageHistories(existing, msgs);
      }
      for (const [id, dmMsgs] of incoming.dms) {
        const existing = this.dms.get(id);
        if (existing === undefined) {
          this.dms.set(id, dmMsgs);
          continue;
        }
        mergeMessageHistories(existing, dmMsgs);
      }
      for (const [agentId, events] of Object.entries(state.deliveryQueues)) {
        const seen = new Set(
          (this.deliveryQueues.get(agentId) ?? []).map((e) =>
            JSON.stringify(e),
          ),
        );
        for (const event of events) {
          if (seen.has(JSON.stringify(event))) continue;
          this.queueDelivery(agentId, event);
          // Replay fires only for events with consumption evidence (#28):
          // messages are consumed by reading (readBy), invites by acceptance
          // or decline (no longer in the invited list). Transient
          // notifications (member_joined, room_members, connection_request,
          // delivery status) carry no consumption evidence, so replaying
          // them could only ever duplicate-notify; the state they describe
          // arrives via the synced room and agent records instead. They
          // still merge into the queue, so drain bridges see them.
          if (event.type === "room_message" || event.type === "dm") {
            this.fireLocalDelivery(agentId, event);
          } else if (event.type === "room_invite") {
            const stillInvited = this.rooms
              .get(event.room)
              ?.invited.includes(agentId);
            if (stillInvited === true) {
              this.fireLocalDelivery(agentId, event);
            }
          }
        }
      }
    }
  }

  private async handleDataMessage(
    handle: ConnectionHandle,
    msg: MeshMessage,
  ): Promise<void> {
    if (msg.method === "state_sync") {
      this.applyStateSync(normaliseWireState(msg.state));
    } else if (msg.method === "state_update") {
      await this.applyPatch(msg.patch);
    }
  }

  private async handleBecomeCoordinator(peerList: PeerInfo[]): Promise<void> {
    // Take over as coordinator using the data server we already have
    await this.requireTransport().becomeCoordinator(
      COORDINATOR_HOST,
      this.coordinatorPort,
    );
    this.peerInfo.clear();
    for (const peer of peerList) {
      this.peerInfo.set(peer.id, peer);
      void this.requireTransport().connectToPeer(peer, this.peerId);
    }
    this.startStaleCheck();
  }

  private handlePeerDisconnected(handle: ConnectionHandle): void {
    this.peerInfo.delete(handle.id);
  }

  // -----------------------------------------------------------------------
  // Connection approval
  // -----------------------------------------------------------------------

  private handleConnectionRequest(
    handle: ConnectionHandle,
    request: {
      peerId: string;
      dataPort: number;
      name: string;
      fingerprint: string;
    },
  ): void {
    this.pendingInboundConnections.set(handle.id, {
      peerId: request.peerId,
      dataPort: request.dataPort,
      name: request.name,
      fingerprint: request.fingerprint,
    });

    // Deliver connection_request event to the owning agent
    const connectionId = handle.id;
    const event: DeliveryEvent = {
      type: "connection_request",
      connectionId,
      peerId: request.peerId,
      dataPort: request.dataPort,
      name: request.name,
      fingerprint: request.fingerprint,
    };
    this.queueDelivery(this.peerId, event);
    if (this.onDelivery) {
      void this.onDelivery(this.peerId, event);
    }
  }

  /** Accept a pending inbound connection. */
  async acceptConnection(connectionId: string): Promise<void> {
    const pending = this.pendingInboundConnections.get(connectionId);
    if (!pending) {
      throw new Error(`No pending connection ${connectionId}`);
    }
    this.pendingInboundConnections.delete(connectionId);
    const handle: ConnectionHandle = { id: connectionId };
    await this.requireTransport().acceptConnection(handle);
  }

  /** Reject a pending inbound connection. */
  async rejectConnection(connectionId: string, reason: string): Promise<void> {
    const pending = this.pendingInboundConnections.get(connectionId);
    if (!pending) {
      throw new Error(`No pending connection ${connectionId}`);
    }
    this.pendingInboundConnections.delete(connectionId);
    const handle: ConnectionHandle = { id: connectionId };
    await this.requireTransport().rejectConnection(handle, reason);
  }

  /** List all pending inbound connections awaiting approval. */
  listPendingConnections(): {
    connectionId: string;
    peerId: string;
    dataPort: number;
    name: string;
    fingerprint: string;
  }[] {
    return [...this.pendingInboundConnections.entries()].map(([id, info]) => ({
      connectionId: id,
      ...info,
    }));
  }

  /** Initiate an outbound connection to a remote coordinator requiring approval.
   *  Fires the connect_request and returns immediately. The connection
   *  completes asynchronously when the coordinator accepts or rejects. */
  connectToRemote(host: string, port: number): Promise<void> {
    const agent = this.agents.get(this.peerId);
    // Fire-and-forget: don't await the full approval handshake.
    // The coordinator will either accept (triggering normal introduction flow)
    // or reject (closing the socket). Handle rejection to avoid unhandled rejection.
    this.requireTransport()
      .connectToRemote(
        host,
        port,
        this.peerId,
        this.requireTransport().dataPort,
        agent?.name ?? "",
        "",
      )
      .catch(() => {
        // Rejection is expected when the coordinator denies the connection.
        // Log silently — the calling tool already returned success.
      });

    return Promise.resolve();
  }

  /** Start only the data server without connecting to a coordinator.
   *  Used for testing scenarios where the peer connects via connectToRemote. */
  async startDataServerOnly(): Promise<void> {
    await this.requireTransport().startDataServer();
    this.peerInfo.set(this.peerId, {
      id: this.peerId,
      port: this.requireTransport().dataPort,
      startedAt: this.startedAt,
    });
    this.requireTransport().unref();
  }

  // -----------------------------------------------------------------------
  // Transport events accessor (for bridges to wire up)
  // -----------------------------------------------------------------------

  /** Returns the TransportEvents object that bridges should pass to the transport constructor. */
  get events(): TransportEvents {
    return {
      onMessage: (handle, msg) => {
        void this.handleDataMessage(handle, msg);
      },
      onPeerConnected: (handle, info) => {
        void this.handlePeerConnected(handle, info);
      },
      onPeerDisconnected: (handle) => {
        this.handlePeerDisconnected(handle);
      },
      onIntroduction: (handle, msg) => {
        void this.handleIntroduction(handle, msg);
      },
      onPeerList: (peers) => {
        this.handlePeerList(peers);
      },
      onPeerJoined: (peer) => {
        this.handlePeerJoined(peer);
      },
      onBecomeCoordinator: (peerList) => {
        void this.handleBecomeCoordinator(peerList);
      },
      onConnectionRequest: (handle, request) => {
        this.handleConnectionRequest(handle, request);
      },
      onError: (error) => {
        this.onError?.(error);
      },
      onRevocationAnnounce: (entry) => {
        void this.handleRevocationAnnounce(entry);
      },
    };
  }

  /** Verifies a gossiped revocation-entry and, if it verifies, records it in this store's own RevocationView -- future verifyRoomToken calls against this token's (token-id, issuer) pair fail with "revoked" from this point on. A failing entry is dropped silently: the same "hostile input produces a verdict, never a throw" contract verifyRevocationEntry itself already guarantees, so there is nothing further for a caller to react to. */
  private async handleRevocationAnnounce(
    entry: RevocationEntry,
  ): Promise<void> {
    const { identity, revocation } = this.requireIdentity();
    await revocation.record(entry, { identity });
  }

  /** Append to a target agent's delivery queue, bounded oldest-first (#28). */
  private queueDelivery(agentId: string, event: DeliveryEvent): void {
    const arr = this.deliveryQueues.get(agentId) ?? [];
    arr.push(event);
    if (arr.length > MAX_QUEUED_DELIVERIES_PER_AGENT) {
      arr.splice(0, arr.length - MAX_QUEUED_DELIVERIES_PER_AGENT);
    }
    this.deliveryQueues.set(agentId, arr);
  }

  /**
   * Merge an incoming room record into the local one. Scalar fields follow
   * the version gate the caller already applied (an equal or higher version
   * reaches here), while membership is always element-merged per agent by
   * highest operation revision, so concurrent joins of different agents
   * survive and a kick racing a join converges with the kick honoured
   * (#27). The members and invited views are re-derived from the merged
   * operations.
   */
  private mergeRoom(incoming: Room): void {
    const existing = this.rooms.get(incoming.id);
    if (existing === undefined) {
      this.refreshMembership(incoming);
      this.rooms.set(incoming.id, incoming);
      return;
    }
    existing.version = Math.max(existing.version, incoming.version);
    existing.name = incoming.name;
    existing.type = incoming.type;
    existing.owner = incoming.owner;
    existing.createdAt = incoming.createdAt;
    existing.description = incoming.description;
    if (incoming.federated !== undefined)
      existing.federated = incoming.federated;
    existing.memberJoins = MeshStore.mergeMemberOps(
      existing.memberJoins,
      incoming.memberJoins,
    );
    existing.memberLeaves = MeshStore.mergeMemberOps(
      existing.memberLeaves,
      incoming.memberLeaves,
    );
    existing.invitedJoins = MeshStore.mergeMemberOps(
      existing.invitedJoins,
      incoming.invitedJoins,
    );
    existing.invitedLeaves = MeshStore.mergeMemberOps(
      existing.invitedLeaves,
      incoming.invitedLeaves,
    );
    this.refreshMembership(existing);
  }

  /**
   * Derive the members and invited views from the per-agent operation maps.
   * An agent is in the list when their latest join strictly outranks their
   * latest leave; equal revisions mean the leave wins, so a kick racing a
   * concurrent join converges with the kick honoured (#27).
   */
  private refreshMembership(room: Room): void {
    room.members = Object.keys(room.memberJoins).filter(
      (id) => (room.memberJoins[id] ?? 0) > (room.memberLeaves[id] ?? 0),
    );
    room.invited = Object.keys(room.invitedJoins).filter(
      (id) => (room.invitedJoins[id] ?? 0) > (room.invitedLeaves[id] ?? 0),
    );
  }

  /** Record a membership operation at the room's current revision. */
  private recordMemberOp(
    room: Room,
    list: "member" | "invited",
    op: "join" | "leave",
    agentId: string,
  ): void {
    const joins = list === "member" ? room.memberJoins : room.invitedJoins;
    const leaves = list === "member" ? room.memberLeaves : room.invitedLeaves;
    const stamp = room.version;
    if (op === "join") joins[agentId] = stamp;
    else leaves[agentId] = stamp;
  }

  /** Merge per-agent operation maps by highest revision per agent. */
  private static mergeMemberOps(
    local: Record<string, number>,
    incoming: Record<string, number>,
  ): Record<string, number> {
    const merged: Record<string, number> = { ...local };
    for (const [id, stamp] of Object.entries(incoming)) {
      if (stamp > (merged[id] ?? 0)) merged[id] = stamp;
    }
    return merged;
  }

  /** Bump an entity's sync revision; call before broadcasting a local mutation. */
  private bump<T extends { version: number }>(entity: T): T {
    entity.version += 1;
    return entity;
  }

  // -----------------------------------------------------------------------
  // State patch application
  // -----------------------------------------------------------------------

  private async applyPatch(patch: MeshStatePatch): Promise<void> {
    switch (patch.type) {
      case "agent_upsert": {
        const existingAgent = this.agents.get(patch.agent.id);
        if (
          existingAgent !== undefined &&
          patch.agent.version < existingAgent.version
        ) {
          // Stale copy from a peer that missed updates (#27).
          break;
        }
        const merged = patch.agent;
        if (existingAgent?.version === patch.agent.version) {
          // Concurrent mutations from the same base: keep subscriptions
          // gained locally. A strictly higher version replaces the record.
          for (const r of existingAgent.subscribedRooms) {
            if (!merged.subscribedRooms.includes(r))
              merged.subscribedRooms.push(r);
          }
        }
        this.agents.set(merged.id, merged);
        break;
      }
      case "agent_offline": {
        const agent = this.agents.get(patch.agentId);
        if (agent) {
          agent.status = "offline";
          this.agents.set(patch.agentId, agent);
        }
        break;
      }
      case "room_upsert": {
        const existing = this.rooms.get(patch.room.id);
        if (existing !== undefined && patch.room.version < existing.version) {
          // Stale copy from a peer that missed updates (#27).
          break;
        }
        this.mergeRoom(patch.room);
        break;
      }
      case "room_delete":
        this.rooms.delete(patch.roomId);
        break;
      case "message_add": {
        const arr = this.messages.get(patch.roomId) ?? [];
        arr.push(patch.message);
        this.messages.set(patch.roomId, arr);
        break;
      }
      case "dm_add": {
        const arr = this.dms.get(patch.key) ?? [];
        arr.push(patch.message);
        this.dms.set(patch.key, arr);
        break;
      }
      case "delivery": {
        this.queueDelivery(patch.agentId, patch.event);
        if (patch.agentId === this.peerId && this.onDelivery) {
          // Deduplicate against local deliveries
          const eventKey = JSON.stringify(patch.event);
          if (this.localDeliveryKeys.has(eventKey)) break;
          this.localDeliveryKeys.add(eventKey);
          if (this.localDeliveryKeys.size > 50) {
            const oldest = this.localDeliveryKeys.values().next().value;
            if (oldest !== undefined) this.localDeliveryKeys.delete(oldest);
          }
          void this.onDelivery(patch.agentId, patch.event);
          // Auto-mark read — scheduled as a macrotask to yield to the event
          // loop. Without this yield, the delivery → markRead → broadcast
          // → peer receives → handleDataMessage chain monopolises the
          // microtask queue and starves macrotasks (timers, new connections,
          // sendRoomMessage return values).
          const evt = patch.event;
          const timer = setTimeout(() => {
            if (this.isShutDown) return;
            if (evt.type === "room_message") {
              void this.markRead(evt.message.id, this.peerId, evt.message.room);
            } else if (evt.type === "dm") {
              void this.markRead(evt.message.id, this.peerId);
            }
          }, 0);
          if (!this.isShutDown) this.pendingMarkReadTimers.push(timer);
        }
        break;
      }
    }

    if (this.onPatch) {
      await this.onPatch(patch);
    }
  }

  // -----------------------------------------------------------------------
  // Broadcast
  // -----------------------------------------------------------------------

  private async broadcastPatch(patch: MeshStatePatch): Promise<void> {
    await this.requireTransport().broadcast({ method: "state_update", patch });
    if (this.onPatch) {
      await this.onPatch(patch);
    }
  }

  private async deliverLocallyAndBroadcast(
    agentId: string,
    event: DeliveryEvent,
  ): Promise<void> {
    // Local delivery
    this.queueDelivery(agentId, event);

    // Auto-emit delivered status for messages
    if (event.type === "room_message") {
      await this.emitDeliveryStatus(
        event.message.id,
        agentId,
        "delivered",
        event.message.room,
      );
    } else if (event.type === "dm") {
      await this.emitDeliveryStatus(event.message.id, agentId, "delivered");
    }

    this.fireLocalDelivery(agentId, event);

    // Remote delivery
    const patch: MeshStatePatch = { type: "delivery", agentId, event };
    await this.broadcastPatch(patch);
  }

  /**
   * Fire onDelivery for an event targeting this peer's own agent, deduped
   * against events already delivered in this process. Used both for live
   * deliveries and for replays of events that accumulated while this
   * process was down (#28): the dedup set is per-process, so a replayed
   * event this process never saw fires, and one it already handled does
   * not.
   */
  private fireLocalDelivery(agentId: string, event: DeliveryEvent): void {
    if (agentId !== this.peerId || !this.onDelivery) return;
    // A room message or DM this agent has already read was already pushed
    // and consumed: read receipts mutate the event between snapshots, so a
    // plain structural key would miss and re-fire on the next sync (#28).
    if (
      (event.type === "room_message" || event.type === "dm") &&
      event.message.readBy.includes(agentId)
    ) {
      return;
    }
    const eventKey = JSON.stringify(event);
    if (this.localDeliveryKeys.has(eventKey)) return;
    this.localDeliveryKeys.add(eventKey);
    // Prevent unbounded growth — evict oldest when cap reached
    if (this.localDeliveryKeys.size > 50) {
      const oldest = this.localDeliveryKeys.values().next().value;
      if (oldest !== undefined) this.localDeliveryKeys.delete(oldest);
    }
    void this.onDelivery(agentId, event);
    // Delivered to this process, so no longer pending for it. Peers that
    // never fired the event keep their copies, which is what a restart
    // replays from (#28). Key-based match: replayed events are JSON clones.
    const queued = this.deliveryQueues.get(agentId);
    if (queued !== undefined) {
      const idx = queued.findIndex((e) => JSON.stringify(e) === eventKey);
      if (idx !== -1) queued.splice(idx, 1);
    }
    // Auto-mark read — scheduled as a macrotask to yield to the event loop.
    const timer = setTimeout(() => {
      if (this.isShutDown) return;
      if (event.type === "room_message") {
        void this.markRead(event.message.id, agentId, event.message.room);
      } else if (event.type === "dm") {
        void this.markRead(event.message.id, agentId);
      }
    }, 0);
    if (!this.isShutDown) this.pendingMarkReadTimers.push(timer);
  }

  private async deliverToRoom(
    roomId: string,
    event: DeliveryEvent,
    excludeAgent?: string,
  ): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room) return;
    for (const memberId of room.members) {
      if (memberId === excludeAgent) continue;
      await this.deliverLocallyAndBroadcast(memberId, event);
    }
  }

  private async notifyRoomsOfStatus(
    agentId: string,
    status: AgentStatus,
  ): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    for (const roomId of agent.subscribedRooms) {
      await this.deliverToRoom(roomId, {
        type: "member_status",
        room: roomId,
        agent: agentId,
        status,
      });
    }
  }

  private async notifyRoomsOfNameChange(
    agentId: string,
    oldName: string,
    newName: string,
  ): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    const event: DeliveryEvent = {
      type: "name_changed",
      agent: agentId,
      oldName,
      newName,
    };
    for (const roomId of agent.subscribedRooms) {
      await this.deliverToRoom(roomId, event, agentId);
    }
    // Also deliver to the agent itself so it sees confirmation
    await this.deliverLocallyAndBroadcast(agentId, event);
  }

  private async emitDeliveryStatus(
    messageId: string,
    agentId: string,
    status: DeliveryStatus,
    room?: string,
  ): Promise<void> {
    // Find the sender for this message
    const senderId = this.findMessageSender(messageId, room);
    if (!senderId) return;
    await this.deliverLocallyAndBroadcast(senderId, {
      type: "delivery_status",
      messageId,
      agent: agentId,
      status,
      room,
    });
  }

  private findMessageSender(
    messageId: string,
    room?: string,
  ): string | undefined {
    if (room) {
      const msgs = this.messages.get(room);
      if (msgs) {
        const msg = msgs.find((m) => m.id === messageId);
        if (msg) return msg.from;
      }
    } else {
      // DM — search all DM queues
      for (const [, msgs] of this.dms) {
        const msg = msgs.find((m) => m.id === messageId);
        if (msg) return msg.from;
      }
    }
    return undefined;
  }

  /** Like findMessageSender, but also returns the room-path a room.read needs to address: room itself for a room message, or the specific DM key (this.dms is keyed by dmRoomPath/"self:...", not the bare pair) the message was actually found under. */
  private findMessageLocation(
    messageId: string,
    room?: string,
  ): { roomPath: string; from: string } | undefined {
    if (room !== undefined) {
      const msg = this.messages.get(room)?.find((m) => m.id === messageId);
      return msg === undefined ? undefined : { roomPath: room, from: msg.from };
    }
    for (const [key, msgs] of this.dms) {
      const msg = msgs.find((m) => m.id === messageId);
      if (msg) return { roomPath: key, from: msg.from };
    }
    return undefined;
  }

  /**
   * Marks a message read by readBy (always this store's own identity -- see the auto-mark-read timers in fireLocalDelivery and drainDelivery, its only callers) and notifies the message's own author via a directed, wire-authenticated room.read (P3.5), replacing the legacy message_read patch's mesh-wide broadcast: only the author is a genuine audience for "did you read my message" per core/room's own always-voluntary read-receipt design, and a direct request to them is strictly more than the old broadcast actually needed. Silently does nothing beyond the local readBy update when the author is this store itself (a self-DM, or an already-own message) or when this store holds no room:member token for the message's own room-path -- read receipts stay best-effort by design, never a reason to throw.
   */
  private async markRead(
    messageId: string,
    readBy: string,
    room?: string,
  ): Promise<void> {
    const location = this.findMessageLocation(messageId, room);
    if (location === undefined) return;
    const { roomPath, from } = location;

    const history =
      room !== undefined ? this.messages.get(room) : this.dms.get(roomPath);
    const message = history?.find((m) => m.id === messageId);
    if (message && !message.readBy.includes(readBy)) {
      message.readBy.push(readBy);
    }

    if (from === readBy) return;

    const { slot, clock } = this.requireIdentity();
    const token = loadRoomTokens(slot)[roomPath];
    if (token === undefined) return;

    const params: Record<string, unknown> = {
      verb: "room.read",
      messages: [bytesFromHex(messageId)],
      at: clock.now(),
    };
    await this.sendRoomRequestToMember(from, roomPath, token, params);
  }

  // -----------------------------------------------------------------------
  // CommsStore — Identity
  // -----------------------------------------------------------------------

  async readIdentity(
    harness: string,
    cwd: string,
  ): Promise<{ id: string } | undefined> {
    await Promise.resolve();
    return this.identityCache.get(`${harness}--${cwd}`);
  }

  async writeIdentity(harness: string, cwd: string, id: string): Promise<void> {
    await Promise.resolve();
    this.identityCache.set(`${harness}--${cwd}`, { id });
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

    const id = this.peerId;
    const agent: AgentIdentity = {
      id,
      version: 1,
      name: opts.name,
      harness: opts.harness,
      cwd: opts.cwd,
      pid: opts.pid,
      startedAt: this.startedAt,
      visibility: opts.visibility,
      status: "active",
      tags: opts.tags,
      subscribedRooms: [],
    };

    this.agents.set(id, agent);
    await this.writeIdentity(opts.harness, opts.cwd, id);
    await this.broadcastPatch({ type: "agent_upsert", agent });
    // Broadcast presence to federated links
    if (agent.visibility === "visible") {
      await this.federation.broadcastAgentVisible(agent);
    }
    return agent;
  }

  async getAgent(id: string): Promise<AgentIdentity | undefined> {
    await Promise.resolve();
    return this.agents.get(id);
  }

  async updateAgent(
    id: string,
    patch: Partial<
      Pick<AgentIdentity, "name" | "visibility" | "status" | "tags" | "pid">
    >,
  ): Promise<AgentIdentity> {
    const agent = this.agents.get(id);
    if (!agent)
      throw new CommsError(`Agent ${id} not found`, "AGENT_NOT_FOUND");

    const oldStatus = agent.status;
    const oldName = agent.name;
    Object.assign(agent, patch);
    this.bump(agent);
    this.agents.set(id, agent);
    await this.broadcastPatch({ type: "agent_upsert", agent });

    if (patch.name !== undefined && patch.name !== oldName) {
      await this.notifyRoomsOfNameChange(id, oldName, patch.name);
    }

    if (patch.status && patch.status !== oldStatus) {
      await this.notifyRoomsOfStatus(id, patch.status);
    }

    return agent;
  }

  async listAgents(requesterId: string): Promise<AgentIdentity[]> {
    await Promise.resolve();
    const result: AgentIdentity[] = [];
    for (const agent of this.agents.values()) {
      if (agent.visibility === "ghost" && agent.id !== requesterId) continue;
      result.push(agent);
    }
    return result;
  }

  async setAgentOffline(id: string): Promise<void> {
    const agent = this.agents.get(id);
    if (!agent) return;
    if (agent.status === "offline") return;

    // Only the owning store should broadcast the status change.
    // Other stores learn about it via the agent_offline mesh patch.
    const isOwner = id === this.peerId;
    agent.status = "offline";
    this.bump(agent);
    this.agents.set(id, agent);

    if (isOwner) {
      await this.notifyRoomsOfStatus(id, "offline");
      await this.broadcastPatch({ type: "agent_offline", agentId: id });
      await this.federation.broadcastAgentGone(id);
    }
  }

  // -----------------------------------------------------------------------
  // CommsStore — Rooms
  // -----------------------------------------------------------------------

  /**
   * Mints and persists the room owner's own self-signed room:member grant: issuer = bearer = owner, no parent, delegationsRemaining: 0. This is deliberately NOT the parent every later member grant chains through -- a delegations-remaining: 0 parent cannot mint any child at all (mintCapabilityToken refuses a child whose own delegationsRemaining isn't strictly less than its parent's, and there is no value less than 0), so a later join/invite grant is its own independent, parent-less, owner-issued root-level token instead (still satisfying the "chain roots at the path's own owner" obligation, since rootIssuer is just the token's own issuer when it carries no parent). This root grant exists purely so the owner has a token to present for its own room actions, uniformly with every other member, per the design's own "every code path that checks membership does the same thing regardless of who it is checking" reasoning.
   */
  private async mintOwnerRootGrant(
    roomPath: string,
    owner: string,
  ): Promise<void> {
    const { identity, clock, slot } = this.requireIdentity();
    const verdict = await mintCapabilityToken({
      identity,
      clock,
      tokenId: randomId(),
      bearer: deviceIdFromHex(owner),
      capability: "room:member",
      scope: { kind: "room", path: roomPath },
      expires: clock.now() + ROOM_TOKEN_LIFETIME_MS,
      delegationsRemaining: 0,
    });
    if (!verdict.ok) {
      throw new Error(
        `MeshStore: failed to mint room owner grant for ${roomPath}: ${verdict.reason}`,
      );
    }
    saveRoomToken(slot, roomPath, verdict.token);
  }

  /**
   * Room verb handlers this store registers with its own WireMeshTransport, keyed by params.verb per room-router.ts's own dispatch discipline. A getter (not a plain field) so every access reads through the current `this` binding without needing a constructor-time closure -- mirrors the `events` getter's own reasoning below.
   */
  get roomVerbHandlers(): Partial<Record<string, RoomVerbHandler>> {
    return {
      "room.join": (request, handle) => this.handleRoomJoin(request, handle),
      "room.send": (request, handle) => this.handleRoomSend(request, handle),
      "room.read": (request, handle) => this.handleRoomRead(request, handle),
      "room.members": (request, handle) =>
        this.handleRoomMembers(request, handle),
      "room.invite": (request) => this.handleRoomInvite(request),
      "room.leave": (request, handle) => this.handleRoomLeave(request, handle),
    };
  }

  /** Reads the "reply" message-ref out of a room.send's own params (if any) and returns the hex id it names -- room.send's replyTo carries a single parent message, so the first reply-relation ref is the one that matters; any further refs are a future relation this handler doesn't yet act on. */
  private static replyToFromRefs(
    refs: readonly MessageRef[] | undefined,
  ): string | undefined {
    const reply = refs?.find((ref) => ref.relation === "reply");
    return reply === undefined ? undefined : bytesToHex(reply.id);
  }

  /** Reads room.send's own "streaming-behavior" extension field (open params tail, not a named schema field) and validates it against the same StreamingBehavior contract every other delivery path already enforces -- an unrecognised or malformed value is dropped rather than rejecting the whole send, matching core/room's own obligation to ignore what it doesn't understand instead of failing closed on an extension field. */
  private static streamingBehaviorFromParams(
    params: Readonly<Record<string, unknown>>,
  ): StreamingBehavior | undefined {
    const raw = params["streaming-behavior"];
    if (raw === undefined) return undefined;
    const result = StreamingBehavior.safeParse(raw);
    return result.success ? result.data : undefined;
  }

  /**
   * Receiving side of a directed room.send (P3.5): verifies the presented token against all six of core/room's own obligations, then delivers the message locally exactly once -- the manage-response this returns IS the delivery receipt, so there is no separate "delivered" event to emit the way the legacy broadcastPatch path needed one. Branches on the room-path's own shape: an owner-named path stores a RoomMessage in this room's own history and fires a room_message event; a DM path stores a DmMessage keyed by the same dm-path sendDm already uses and fires a dm event -- both ride the identical room:member-gated verb, since a DM is just a room-path variant, not a separate verb.
   */
  private async handleRoomSend(
    request: IncomingManageRequest,
    handle: ConnectionHandle,
  ): Promise<ManageOutcome> {
    const roomPath = request.scope.path;
    if (roomPath === undefined) {
      return { result: "error", code: "missing_scope_path" };
    }
    if (request.token === undefined) {
      return { result: "error", code: "unauthorized" };
    }
    const { identity, clock, revocation } = this.requireIdentity();
    const verdict = await verifyRoomToken(request.token, {
      identity,
      clock,
      revocation,
      expectedBearer: deviceIdFromHex(handle.id),
      roomPath,
    });
    if (!verdict.ok) {
      return { result: "error", code: "unauthorized" };
    }

    const parsedParams = roomSendSchema.safeParse(request.command.params);
    if (!parsedParams.success) {
      return { result: "error", code: "malformed_params" };
    }
    const params = parsedParams.data;
    const replyTo = MeshStore.replyToFromRefs(params.refs);
    const streamingBehavior = MeshStore.streamingBehaviorFromParams(params);
    const id = bytesToHex(params["message-id"]);
    const timestamp = new Date(params["sent-at"]).toISOString();

    const parsedPath = parseRoomPath(roomPath);
    let event: DeliveryEvent;
    if (parsedPath.kind === "dm") {
      const message: DmMessage = {
        id,
        from: handle.id,
        to: this.peerId,
        content: params.text,
        timestamp,
        readBy: [handle.id],
        ...(streamingBehavior !== undefined && { streamingBehavior }),
      };
      const history = this.dms.get(roomPath) ?? [];
      history.push(message);
      this.dms.set(roomPath, history);
      event = { type: "dm", message };
    } else {
      const message: RoomMessage = {
        id,
        from: handle.id,
        room: roomPath,
        content: params.text,
        timestamp,
        readBy: [handle.id],
        ...(replyTo !== undefined && { replyTo }),
        ...(streamingBehavior !== undefined && { streamingBehavior }),
      };
      const history = this.messages.get(roomPath) ?? [];
      history.push(message);
      this.messages.set(roomPath, history);
      event = { type: "room_message", message };
    }

    this.queueDelivery(this.peerId, event);
    this.fireLocalDelivery(this.peerId, event);

    return { result: "ok" };
  }

  /**
   * Receiving side of a directed room.read (P3.5): verifies the presented token the same way handleRoomSend does, then for each read message-id in the batch, updates this store's own local copy of that message's readBy (this store holds one because it's the message's own author -- the reason it's the one being notified) and fires a delivery_status event locally, replacing what markRead used to broadcast via the legacy message_read patch. Read receipts stay voluntary and best-effort by design: a message-id this store doesn't recognise (already expired from history, or simply never this store's own) is silently skipped rather than treated as an error.
   */
  private async handleRoomRead(
    request: IncomingManageRequest,
    handle: ConnectionHandle,
  ): Promise<ManageOutcome> {
    const roomPath = request.scope.path;
    if (roomPath === undefined) {
      return { result: "error", code: "missing_scope_path" };
    }
    if (request.token === undefined) {
      return { result: "error", code: "unauthorized" };
    }
    const { identity, clock, revocation } = this.requireIdentity();
    const verdict = await verifyRoomToken(request.token, {
      identity,
      clock,
      revocation,
      expectedBearer: deviceIdFromHex(handle.id),
      roomPath,
    });
    if (!verdict.ok) {
      return { result: "error", code: "unauthorized" };
    }

    const parsedParams = roomReadSchema.safeParse(request.command.params);
    if (!parsedParams.success) {
      return { result: "error", code: "malformed_params" };
    }
    const params = parsedParams.data;
    const isDm = parseRoomPath(roomPath).kind === "dm";

    for (const messageIdBytes of params.messages) {
      const messageId = bytesToHex(messageIdBytes);
      const history = isDm
        ? this.dms.get(roomPath)
        : this.messages.get(roomPath);
      const message = history?.find((m) => m.id === messageId);
      if (message === undefined) continue;
      if (!message.readBy.includes(handle.id)) {
        message.readBy.push(handle.id);
      }
      const event: DeliveryEvent = {
        type: "delivery_status",
        messageId,
        agent: handle.id,
        status: "read",
        ...(isDm ? {} : { room: roomPath }),
      };
      this.queueDelivery(this.peerId, event);
      this.fireLocalDelivery(this.peerId, event);
    }

    return { result: "ok" };
  }

  /**
   * Receiving side of room.members (P3.6): a plain membership + room-state refresh for an already-admitted member, verified the same way handleRoomSend/handleRoomRead are -- room.members grants nothing new, it just answers "who's here, and what's this room called" on demand, the same information room.join's own response already carries at admission time. A DM path has no Room record (this.rooms never holds one for a dm-shaped path) and no name/description/type to report, so its own members list is derived directly from the path's own two participants instead.
   */
  private async handleRoomMembers(
    request: IncomingManageRequest,
    handle: ConnectionHandle,
  ): Promise<ManageOutcome> {
    const roomPath = request.scope.path;
    if (roomPath === undefined) {
      return { result: "error", code: "missing_scope_path" };
    }
    if (request.token === undefined) {
      return { result: "error", code: "unauthorized" };
    }
    const { identity, clock, revocation } = this.requireIdentity();
    const verdict = await verifyRoomToken(request.token, {
      identity,
      clock,
      revocation,
      expectedBearer: deviceIdFromHex(handle.id),
      roomPath,
    });
    if (!verdict.ok) {
      return { result: "error", code: "unauthorized" };
    }

    const parsedPath = parseRoomPath(roomPath);
    const room = this.rooms.get(roomPath);
    const members =
      parsedPath.kind === "dm"
        ? parsedPath.participants.map((device) => ({
            device: deviceIdFromHex(device),
          }))
        : (room?.members ?? []).map((memberId) => ({
            device: deviceIdFromHex(memberId),
          }));

    return {
      result: "ok",
      members,
      ...MeshStore.roomStateExtension(room),
    };
  }

  /**
   * Sends one directed room.send to a single member's own session, attaching this store's own persisted room:member token for the given room path -- the primitive P3.5's own directed fan-out (deliverToRoom) will loop over per member once it replaces the legacy broadcastPatch path this store still uses for message delivery today. Throws if this store holds no token for the room: never a member, or a token that expired or was revoked with nothing fresh persisted in its place.
   */
  async sendRoomMessageDirected(
    roomPath: string,
    memberId: string,
    text: string,
  ): Promise<void> {
    const { slot, clock } = this.requireIdentity();
    const token = loadRoomTokens(slot)[roomPath];
    if (token === undefined) {
      throw new CommsError(
        `No room:member token for ${roomPath}`,
        "NOT_A_MEMBER",
      );
    }
    const outcome = await this.requireTransport().sendRoomRequest(
      memberId,
      {
        verb: ROOM_MEMBER_CAPABILITY,
        params: {
          verb: "room.send",
          "message-id": randomId(),
          "sent-at": clock.now(),
          text,
        },
      },
      { kind: "room", path: roomPath },
      token,
    );
    if (outcome.result !== "ok") {
      throw new CommsError(
        `room.send to ${memberId} for ${roomPath} failed (${outcome.code})`,
        "SEND_FAILED",
      );
    }
  }

  /** Records a room-domain request that couldn't reach memberId right now, for a later flushPendingRoomRequests to retry once that member reconnects. Bounded oldest-first with the same cap ordinary delivery queues use, so an indefinitely-offline member cannot grow this without limit. */
  private queuePendingRoomRequest(
    memberId: string,
    roomPath: string,
    params: Record<string, unknown>,
  ): void {
    const queue = this.pendingRoomRequests.get(memberId) ?? [];
    queue.push({ roomPath, params });
    if (queue.length > MAX_QUEUED_DELIVERIES_PER_AGENT) {
      queue.splice(0, queue.length - MAX_QUEUED_DELIVERIES_PER_AGENT);
    }
    this.pendingRoomRequests.set(memberId, queue);
  }

  /**
   * Sends one directed room-domain request (room.send, room.read, or any future room:member-gated verb) to a single member, queuing it for retry instead of throwing when the member isn't currently reachable -- the fan-out's own per-recipient primitive, distinct from sendRoomMessageDirected's deliberate throw-on-failure contract for a caller sending to one specific, known recipient. Silently drops a request this store no longer holds a token for (no longer a member of the room) rather than queuing something that will only fail again on retry.
   */
  private async sendRoomRequestToMember(
    memberId: string,
    roomPath: string,
    token: CapabilityToken,
    params: Record<string, unknown>,
  ): Promise<void> {
    // sendRoomRequest can reject outright (e.g. the connection drops mid-request, per wire-mesh-core's own rejectPendingManageRequests), not just resolve with an error outcome -- both are exactly the same "memberId isn't reachable right now" fact from this method's own point of view, so both queue for retry rather than one of them propagating as an uncaught rejection out of what every caller treats as a fire-and-forget send.
    let outcome: ManageOutcome;
    try {
      outcome = await this.requireTransport().sendRoomRequest(
        memberId,
        { verb: ROOM_MEMBER_CAPABILITY, params },
        { kind: "room", path: roomPath },
        token,
      );
    } catch {
      this.queuePendingRoomRequest(memberId, roomPath, params);
      return;
    }
    if (outcome.result !== "ok") {
      this.queuePendingRoomRequest(memberId, roomPath, params);
    }
  }

  /** Retries every room.send queued for memberId since it was last reachable, dropping (not re-queuing) any whose room this store no longer holds a token for. Called once a connection to memberId is (re)established -- handlePeerConnected fires for both a fresh introduction and a reconnection after downtime, exactly the two cases a queued send needs to be retried on. */
  private async flushPendingRoomRequests(memberId: string): Promise<void> {
    const queue = this.pendingRoomRequests.get(memberId);
    if (queue === undefined || queue.length === 0) return;
    this.pendingRoomRequests.delete(memberId);
    const { slot } = this.requireIdentity();
    for (const pending of queue) {
      const token = loadRoomTokens(slot)[pending.roomPath];
      if (token === undefined) continue;
      await this.sendRoomRequestToMember(
        memberId,
        pending.roomPath,
        token,
        pending.params,
      );
    }
  }

  /**
   * Owner-side admission for an incoming room.join request, against either a named room this store owns or a DM path this store is a participant of. Named-room admission always needs a human decision; DM admission needs one only for the party being contacted first -- the reply half of the two-round consent flow (section 6) auto-approves, since a reply on a path this node itself opened is not unsolicited contact.
   */
  private async handleRoomJoin(
    request: IncomingManageRequest,
    handle: ConnectionHandle,
  ): Promise<ManageOutcome> {
    const roomPath = request.scope.path;
    if (roomPath === undefined) {
      return { result: "error", code: "missing_scope_path" };
    }
    const parsed = parseRoomPath(roomPath);

    if (parsed.kind === "owner-named") {
      if (parsed.owner !== this.peerId) {
        return { result: "error", code: "not_owner" };
      }
      return this.admitRoomJoin(roomPath, handle, false);
    }

    if (!parsed.participants.includes(this.peerId)) {
      return { result: "error", code: "not_participant" };
    }
    // The reciprocal half of section 6's own two-round DM flow: this node's own outbound room.join to the same path (recorded by joinRemoteRoom before this response was even awaited) is the consent that makes the counterpart's own reply not unsolicited contact.
    const autoApprove = this.dmRequestsInitiatedByMe.has(roomPath);
    return this.admitRoomJoin(roomPath, handle, autoApprove);
  }

  /** Shared admission continuation for both room.join branches above: waits for a human decision (unless auto-approved), then mints and returns the requester's own independent, parent-less room:member grant. */
  private async admitRoomJoin(
    roomPath: string,
    handle: ConnectionHandle,
    autoApprove: boolean,
  ): Promise<ManageOutcome> {
    const decision: RoomJoinDecision = autoApprove
      ? { kind: "accept" }
      : await new Promise<RoomJoinDecision>((resolve) => {
          this.pendingRoomJoins.set(`${roomPath}::${handle.id}`, {
            roomPath,
            requesterId: handle.id,
            resolve,
          });
        });
    if (!autoApprove) this.pendingRoomJoins.delete(`${roomPath}::${handle.id}`);
    if (decision.kind === "reject") {
      return {
        result: "error",
        code: "denied",
        ...(decision.reason !== undefined ? { message: decision.reason } : {}),
      };
    }

    // The granted token itself belongs to the requester's own node, which persists it itself once it receives this response -- but this identity slot must also remember the token-id it just issued (saveIssuedRoomGrant below), since revoking a specific member's grant later (kickFromRoom) has no other way to name which token-id to revoke: a token-id is never presented back on the wire, so a room owner's own memory of having minted it is the only record.
    const { identity, clock, slot } = this.requireIdentity();
    const tokenId = randomId();
    const verdict = await mintCapabilityToken({
      identity,
      clock,
      tokenId,
      bearer: deviceIdFromHex(handle.id),
      capability: "room:member",
      scope: { kind: "room", path: roomPath },
      expires: clock.now() + ROOM_TOKEN_LIFETIME_MS,
      delegationsRemaining: 0,
    });
    if (!verdict.ok) {
      return { result: "error", code: "mint_failed" };
    }
    saveIssuedRoomGrant(slot, roomPath, handle.id, tokenId);

    const room = this.rooms.get(roomPath);
    if (room !== undefined) {
      this.bump(room);
      this.recordMemberOp(room, "member", "join", handle.id);
      this.refreshMembership(room);
      this.rooms.set(roomPath, room);
    }

    const members = (room?.members ?? [this.peerId, handle.id]).map(
      (memberId) => ({ device: deviceIdFromHex(memberId) }),
    );
    return {
      result: "ok",
      "granted-token": verdict.token,
      members,
      ...MeshStore.roomStateExtension(room),
    };
  }

  /**
   * Room metadata (name/description/type) riding room-join-ok/room-members-ok's own open extension tail (P3.6), agent-comms' own convention for the "namespaced room-state extension" the design names -- core/room itself has no concept of a display name or description, so this is application data, not a wire-level field. Absent entirely for a DM path (room is undefined there; a DM has no name/description/type to report) rather than a hollow placeholder.
   */
  private static roomStateExtension(room: Readonly<Room> | undefined): {
    "room-state"?: { name: string; description: string; type: RoomType };
  } {
    if (room === undefined) return {};
    return {
      "room-state": {
        name: room.name,
        description: room.description,
        type: room.type,
      },
    };
  }

  /** The receiving-side counterpart of roomStateExtension: narrows an incoming response's own "room-state" field (an unknown, since it rides the wire schema's open catchall tail) to the shape this store's own convention actually sends, or undefined for a peer running without it (an older version, or a DM's own room-join-ok, which never carries one). */
  private static parseRoomStateExtension(
    value: unknown,
  ): { name: string; description: string; type: RoomType } | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    if (!("name" in value) || !("description" in value) || !("type" in value))
      return undefined;
    if (typeof value.name !== "string" || typeof value.description !== "string")
      return undefined;
    const parsedType = RoomType.safeParse(value.type);
    if (!parsedType.success) return undefined;
    return {
      name: value.name,
      description: value.description,
      type: parsedType.data,
    };
  }

  /**
   * The inviter's own display name and cwd, riding room-invite's own open extension tail -- agent-comms' own application data, the same convention roomStateExtension already establishes for room metadata. Unlike room-state (which needs gossip on the requester's own side of room.join/members), the inviter here is always this store's own local agent record: inviteToRoom only ever succeeds for the room's real owner, which per this store's own organising fact (one bridge is one agent is one device) is always this.peerId, so the record is always this store's own registration, never a gossip-dependent lookup.
   */
  private static inviterAgentExtension(inviter: Readonly<AgentIdentity>): {
    "inviter-agent": { name: string; cwd: string };
  } {
    return { "inviter-agent": { name: inviter.name, cwd: inviter.cwd } };
  }

  /** The receiving-side counterpart of inviterAgentExtension: narrows an incoming room.invite's own "inviter-agent" field to the shape this store's own convention sends, or undefined for a peer running without it (an older version) -- the caller falls back to the inviter's bare device-id in that case, the same honest degradation parseRoomStateExtension's own absent case already accepts. */
  private static parseInviterAgentExtension(
    value: unknown,
  ): { name: string; cwd: string } | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    if (!("name" in value) || !("cwd" in value)) return undefined;
    if (typeof value.name !== "string" || typeof value.cwd !== "string")
      return undefined;
    return { name: value.name, cwd: value.cwd };
  }

  /**
   * Receiving side of a real, wire-level room.invite (P3.8): unlike every other room verb, the request itself is deliberately ungated (the sender already IS the room's own owner, with no need to prove capability to invite) -- the security instead lives entirely in the embedded params.token, which must genuinely name this store's own identity as bearer and root at the room path's own claimed owner. Persists the verified token via saveRoomToken (mirroring joinRemoteRoom's own persistence) and fires a local room_invite delivery event carrying the room's real name/description (room-state) and the inviter's real name/cwd (inviter-agent) when the sender includes them, falling back to the bare device-id and room path otherwise.
   */
  private async handleRoomInvite(
    request: IncomingManageRequest,
  ): Promise<ManageOutcome> {
    const roomPath = request.scope.path;
    if (roomPath === undefined) {
      return { result: "error", code: "missing_scope_path" };
    }
    const parsedParams = roomInviteSchema.safeParse(request.command.params);
    if (!parsedParams.success) {
      return { result: "error", code: "malformed_params" };
    }
    const { token } = parsedParams.data;

    const { identity, clock, slot, revocation } = this.requireIdentity();
    const verdict = await verifyRoomToken(token, {
      identity,
      clock,
      revocation,
      expectedBearer: deviceIdFromHex(this.peerId),
      roomPath,
    });
    if (!verdict.ok) {
      return { result: "error", code: "unauthorized" };
    }
    saveRoomToken(slot, roomPath, token);

    const parsed = parseRoomPath(roomPath);
    const inviterId =
      parsed.kind === "owner-named" ? parsed.owner : this.peerId;
    const roomState = MeshStore.parseRoomStateExtension(
      parsedParams.data["room-state"],
    );
    const inviterAgent = MeshStore.parseInviterAgentExtension(
      parsedParams.data["inviter-agent"],
    );
    const event: DeliveryEvent = {
      type: "room_invite",
      room: roomPath,
      roomDescription: roomState?.description ?? "",
      from: inviterId,
      fromName: inviterAgent?.name ?? inviterId,
      fromCwd: inviterAgent?.cwd ?? "",
    };
    this.queueDelivery(this.peerId, event);
    this.fireLocalDelivery(this.peerId, event);

    return { result: "ok" };
  }

  /**
   * Receiving side of a real, wire-level room.leave (P3.8), covering both an actual member leaving and a decline of a never-joined invite -- the same wire request either way, since both are "give up a room:member grant I hold," per leaveRemoteRoom's own reasoning. Distinguishes the two purely from this store's own membership/invited lists (never from anything the sender claims), revokes the sender's grant for real via revokeMemberGrant, and notifies accordingly: member_left broadcast to the room's other members for a real leave, a local invite_declined event (carrying the sender's own optional reason extension) for a decline -- there is no third party to notify for a decline, since nobody else ever knew about an invite that was never accepted.
   */
  private async handleRoomLeave(
    request: IncomingManageRequest,
    handle: ConnectionHandle,
  ): Promise<ManageOutcome> {
    const roomPath = request.scope.path;
    if (roomPath === undefined) {
      return { result: "error", code: "missing_scope_path" };
    }
    if (request.token === undefined) {
      return { result: "error", code: "unauthorized" };
    }
    const { identity, clock, revocation } = this.requireIdentity();
    const verdict = await verifyRoomToken(request.token, {
      identity,
      clock,
      revocation,
      expectedBearer: deviceIdFromHex(handle.id),
      roomPath,
    });
    if (!verdict.ok) {
      return { result: "error", code: "unauthorized" };
    }
    const parsedParams = roomLeaveSchema.safeParse(request.command.params);
    if (!parsedParams.success) {
      return { result: "error", code: "malformed_params" };
    }

    const room = this.rooms.get(roomPath);
    if (room === undefined) {
      return { result: "error", code: "room_not_found" };
    }
    const wasMember = room.members.includes(handle.id);
    const wasInvited = room.invited.includes(handle.id);
    if (!wasMember && !wasInvited) {
      return { result: "ok" };
    }

    await this.revokeMemberGrant(roomPath, handle.id);

    this.bump(room);
    if (wasMember) this.recordMemberOp(room, "member", "leave", handle.id);
    if (wasInvited) this.recordMemberOp(room, "invited", "leave", handle.id);
    this.refreshMembership(room);
    this.rooms.set(roomPath, room);
    await this.broadcastPatch({ type: "room_upsert", room });

    if (wasMember) {
      await this.deliverToRoom(
        roomPath,
        { type: "member_left", room: roomPath, agent: handle.id },
        handle.id,
      );
    } else {
      const reasonValue = parsedParams.data.reason;
      const decliner = this.agents.get(handle.id);
      const event: DeliveryEvent = {
        type: "invite_declined",
        room: roomPath,
        agent: handle.id,
        agentName: decliner?.name ?? handle.id,
        reason: typeof reasonValue === "string" ? reasonValue : "",
      };
      this.queueDelivery(this.peerId, event);
      this.fireLocalDelivery(this.peerId, event);
    }

    return { result: "ok" };
  }

  /** Every room.join request currently held open awaiting this store's own accept/reject decision. */
  listPendingRoomJoins(): { roomPath: string; requesterId: string }[] {
    return [...this.pendingRoomJoins.values()].map(
      ({ roomPath, requesterId }) => ({ roomPath, requesterId }),
    );
  }

  /** Approves a pending room.join request, resuming handleRoomJoin's own suspended mint-and-respond continuation. */
  acceptRoomJoin(roomPath: string, requesterId: string): void {
    const key = `${roomPath}::${requesterId}`;
    const pending = this.pendingRoomJoins.get(key);
    if (pending === undefined) {
      throw new CommsError(
        `No pending room.join for ${requesterId} on ${roomPath}`,
        "NOT_PENDING",
      );
    }
    pending.resolve({ kind: "accept" });
  }

  /** Denies a pending room.join request, optionally with a reason surfaced to the requester in the resulting manage-error's own message field. */
  rejectRoomJoin(roomPath: string, requesterId: string, reason?: string): void {
    const key = `${roomPath}::${requesterId}`;
    const pending = this.pendingRoomJoins.get(key);
    if (pending === undefined) {
      throw new CommsError(
        `No pending room.join for ${requesterId} on ${roomPath}`,
        "NOT_PENDING",
      );
    }
    pending.resolve({
      kind: "reject",
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  async createRoom(opts: {
    name: string;
    type: RoomType;
    owner: string;
    description: string;
    federated?: boolean;
  }): Promise<Room> {
    // slugRoomName sanitises an arbitrary caller-supplied name (e.g. from a live create_room tool call, not just an internal cwd basename) into the room-path grammar's [A-Za-z0-9_-]+ charset -- createRoom is the one choke point every room creation goes through, so this is the right place to do it rather than trusting every caller to have pre-slugged, the way the old bare-name id never required at all.
    const slugName = slugRoomName(opts.name);
    const localName = opts.type === "secret" ? `_${slugName}` : slugName;
    const id = ownerNamedRoomPath(opts.owner, localName);
    if (this.rooms.has(id))
      throw new CommsError(`Room ${id} already exists`, "ROOM_EXISTS");

    // Every room creation this store performs is local: opts.owner is always this bridge's own identity (create_room's caller passes ctx.agentId, and one bridge process is one agent is one device), so minting the owner's own root grant here always signs under the identity this store was wired with, never someone else's.
    await this.mintOwnerRootGrant(id, opts.owner);

    const room: Room = {
      id,
      version: 1,
      name: slugName,
      type: opts.type,
      owner: opts.owner,
      createdAt: new Date().toISOString(),
      description: opts.description,
      members: [opts.owner],
      invited: [],
      memberJoins: { [opts.owner]: 1 },
      memberLeaves: {},
      invitedJoins: {},
      invitedLeaves: {},
      federated: opts.federated ?? false,
    };

    this.rooms.set(id, room);
    this.messages.set(id, []);
    await this.broadcastPatch({ type: "room_upsert", room });
    return room;
  }

  async getRoom(id: string): Promise<Room | undefined> {
    await Promise.resolve();
    return this.rooms.get(id);
  }

  async listRooms(requesterId: string): Promise<Room[]> {
    await Promise.resolve();
    const result: Room[] = [];
    for (const room of this.rooms.values()) {
      if (room.type === "secret" && !room.members.includes(requesterId))
        continue;
      result.push(room);
    }
    return result;
  }

  /**
   * The remote-join path: roomPath names an owner-named room this store has never seen replicated, so joining it means sending a real wire-level room.join request to the room's own owner and persisting whatever grant comes back, rather than mutating already-known local state. Only ever called for this store's own local agent (one bridge is one agent is one device, per the design's own organising fact) -- there is no wire mechanism by which this node could join a room on a different local agent's behalf.
   */
  private async joinRemoteRoom(
    roomPath: string,
    agentId: string,
  ): Promise<Room> {
    if (agentId !== this.peerId) {
      throw new CommsError(`Room ${roomPath} not found`, "ROOM_NOT_FOUND");
    }
    const parsed = parseRoomPath(roomPath);
    if (parsed.kind !== "owner-named") {
      throw new CommsError(`Room ${roomPath} not found`, "ROOM_NOT_FOUND");
    }

    const outcome = await this.requireTransport().sendRoomRequest(
      parsed.owner,
      { verb: ROOM_MEMBER_CAPABILITY, params: { verb: "room.join" } },
      { kind: "room", path: roomPath },
    );
    if (outcome.result !== "ok") {
      throw new CommsError(
        `Join request for ${roomPath} was refused (${outcome.code})`,
        "JOIN_REFUSED",
      );
    }
    const parsedOutcome = roomJoinOkSchema.safeParse(outcome);
    if (!parsedOutcome.success) {
      throw new CommsError(
        `Join response for ${roomPath} was malformed`,
        "MALFORMED_RESPONSE",
      );
    }
    const { "granted-token": grantedToken, members: memberList } =
      parsedOutcome.data;

    const { slot } = this.requireIdentity();
    saveRoomToken(slot, roomPath, grantedToken);

    const members = memberList.map((member) => deviceIdToHex(member.device));
    const roomState = MeshStore.parseRoomStateExtension(
      parsedOutcome.data["room-state"],
    );
    const room: Room = {
      id: roomPath,
      version: 1,
      name: roomState?.name ?? parsed.localName,
      // Falls back to "public" only against a peer running without the room-state extension (an older version); this joiner is always in `members` by construction regardless, so a stale "public" classification here never hides the room from its own member -- the one place type is read (listRooms' secret-room filter).
      type: roomState?.type ?? "public",
      owner: parsed.owner,
      createdAt: new Date().toISOString(),
      description: roomState?.description ?? "",
      members,
      invited: [],
      memberJoins: Object.fromEntries(members.map((member) => [member, 1])),
      memberLeaves: {},
      invitedJoins: {},
      invitedLeaves: {},
      federated: false,
    };
    this.rooms.set(roomPath, room);
    this.messages.set(roomPath, []);
    return room;
  }

  /**
   * Refreshes this store's own local copy of a named room's membership and room-state via a real room.members request (P3.6): the same information room.join's own response carries at admission time, available on demand for a member whose local copy may have drifted (a kick, an invite, a rename since it joined). Sent to the room's own owner, the authoritative source for that room's real state. Named rooms only, matching joinRemoteRoom's own restriction -- a DM's "membership" is already fully known from the path itself (the sorted pair of exactly two participants), and this codebase has no Room-object representation for a DM to refresh into (DM state lives in this.dms, keyed by message history, not this.rooms). Throws if this store holds no room:member token for roomPath -- refreshing membership presupposes already being a member, the same NOT_A_MEMBER contract sendRoomMessageDirected already uses.
   */
  async refreshRoomMembers(roomPath: string): Promise<Room> {
    const parsed = parseRoomPath(roomPath);
    if (parsed.kind !== "owner-named") {
      throw new CommsError(`Room ${roomPath} not found`, "ROOM_NOT_FOUND");
    }
    const { slot } = this.requireIdentity();
    const token = loadRoomTokens(slot)[roomPath];
    if (token === undefined) {
      throw new CommsError(
        `No room:member token for ${roomPath}`,
        "NOT_MEMBER",
      );
    }

    const outcome = await this.requireTransport().sendRoomRequest(
      parsed.owner,
      { verb: ROOM_MEMBER_CAPABILITY, params: { verb: "room.members" } },
      { kind: "room", path: roomPath },
      token,
    );
    if (outcome.result !== "ok") {
      throw new CommsError(
        `room.members refresh for ${roomPath} failed (${outcome.code})`,
        "REFRESH_FAILED",
      );
    }
    const parsedOutcome = roomMembersOkSchema.safeParse(outcome);
    if (!parsedOutcome.success) {
      throw new CommsError(
        `room.members response for ${roomPath} was malformed`,
        "MALFORMED_RESPONSE",
      );
    }
    const members = parsedOutcome.data.members.map((member) =>
      deviceIdToHex(member.device),
    );
    const roomState = MeshStore.parseRoomStateExtension(
      parsedOutcome.data["room-state"],
    );

    const existing = this.rooms.get(roomPath);
    const room: Room = {
      id: roomPath,
      version: (existing?.version ?? 0) + 1,
      name: roomState?.name ?? existing?.name ?? parsed.localName,
      type: roomState?.type ?? existing?.type ?? "public",
      owner: parsed.owner,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      description: roomState?.description ?? existing?.description ?? "",
      members,
      invited: existing?.invited ?? [],
      memberJoins: Object.fromEntries(members.map((member) => [member, 1])),
      memberLeaves: {},
      invitedJoins: existing?.invitedJoins ?? {},
      invitedLeaves: existing?.invitedLeaves ?? {},
      federated: existing?.federated ?? false,
    };
    this.rooms.set(roomPath, room);
    return room;
  }

  /**
   * The requester's own half of section 6's two-round DM consent flow: sends an ungated room.join scoped to dmRoomPath(this, counterpart) directly to the counterpart, records having initiated it so the counterpart's own reciprocal room.join back auto-approves rather than surfacing as a fresh, unsolicited request, and persists whatever grant comes back. Deliberately outside the CommsStore interface, like connection approval, since it is a wire-mesh-specific concern FileStore has no equivalent for. Safe to call again for the same counterpart later (e.g. after an earlier request expired or was rejected) -- it always sends a fresh request rather than checking for an existing token first.
   */
  async requestDmAccess(counterpart: string): Promise<void> {
    const dmPath = dmRoomPath(this.peerId, counterpart);
    this.dmRequestsInitiatedByMe.add(dmPath);
    const outcome = await this.requireTransport().sendRoomRequest(
      counterpart,
      { verb: ROOM_MEMBER_CAPABILITY, params: { verb: "room.join" } },
      { kind: "room", path: dmPath },
    );
    if (outcome.result !== "ok") {
      throw new CommsError(
        `DM access request to ${counterpart} was refused (${outcome.code})`,
        "JOIN_REFUSED",
      );
    }
    const parsedOutcome = roomJoinOkSchema.safeParse(outcome);
    if (!parsedOutcome.success) {
      throw new CommsError(
        `DM access response from ${counterpart} was malformed`,
        "MALFORMED_RESPONSE",
      );
    }
    const { slot } = this.requireIdentity();
    saveRoomToken(slot, dmPath, parsedOutcome.data["granted-token"]);
  }

  /**
   * Joins a room. For this store's own identity, "already known locally" is not the right gate for skipping real admission: the legacy full-state-sync replicates a room's metadata to every mesh-connected peer the moment it's created, well before that peer has ever been admitted, so a room already present in this.rooms says nothing about whether this store actually holds a valid room:member token for it. The real gate is that token's presence -- absent, this always goes through joinRemoteRoom's real wire-level admission regardless of what this.rooms already knows, so a peer that merely heard about a room never mistakes hearing about it for having joined it. Joining on behalf of a DIFFERENT agentId (this store's own convergence/admin bookkeeping, exercised directly by state-sync-convergence.test.ts) is untouched -- that's a pure local CRDT mutation with no admission concept at all.
   */
  async joinRoom(roomId: string, agentId: string): Promise<Room> {
    if (agentId === this.peerId) {
      const { slot } = this.requireIdentity();
      if (loadRoomTokens(slot)[roomId] === undefined) {
        return this.joinRemoteRoom(roomId, agentId);
      }
    }
    const room = this.rooms.get(roomId);
    if (!room) return this.joinRemoteRoom(roomId, agentId);

    const alreadyMember = room.members.includes(agentId);
    if (!alreadyMember && room.type !== "public") {
      if (!room.invited.includes(agentId) && room.owner !== agentId) {
        throw new CommsError(`Not invited to room ${roomId}`, "NOT_INVITED");
      }
    }

    this.bump(room);
    this.recordMemberOp(room, "member", "join", agentId);
    if (alreadyMember || room.type !== "public") {
      // Consuming an invitation (or re-joining) retires the invited entry.
      this.recordMemberOp(room, "invited", "leave", agentId);
    }
    this.refreshMembership(room);
    this.rooms.set(roomId, room);

    const agent = this.agents.get(agentId);
    if (agent && !agent.subscribedRooms.includes(roomId)) {
      agent.subscribedRooms.push(roomId);
      this.bump(agent);
      this.agents.set(agentId, agent);
      await this.broadcastPatch({ type: "agent_upsert", agent });
    }

    await this.broadcastPatch({ type: "room_upsert", room });

    // Send current member list to the joining agent
    const members: { id: string; name: string; status: AgentStatus }[] = [];
    for (const memberId of room.members) {
      const memberAgent = this.agents.get(memberId);
      if (memberAgent) {
        members.push({
          id: memberAgent.id,
          name: memberAgent.name,
          status: memberAgent.status,
        });
      }
    }
    await this.deliverLocallyAndBroadcast(agentId, {
      type: "room_members",
      room: roomId,
      members,
    });

    // Notify existing members of the join
    await this.deliverToRoom(
      roomId,
      {
        type: "member_joined",
        room: roomId,
        agent: agentId,
      },
      agentId,
    );

    // Notify federated links if the room is federated
    if (room.federated) {
      const agentName = agent?.name ?? agentId;
      await this.federation.broadcastRoomJoin(roomId, agentId, agentName);
    }

    return room;
  }

  /**
   * Leaves a room. For this store's own identity leaving a room it does not itself own, the local Room object is only ever this store's own static snapshot from when it joined or was invited (P3.6/P3.8) -- mutating it directly, as the legacy branch below does, would tell nobody but this store itself. The real effect needs a wire round trip to the room's own owner instead, so this always defers to leaveRemoteRoom in that case. Leaving on behalf of a DIFFERENT agentId, or the owner leaving their own room (this store's own authoritative copy), is untouched -- that is the legacy CRDT mutation state-sync-convergence.test.ts exercises directly.
   */
  async leaveRoom(roomId: string, agentId: string): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room)
      throw new CommsError(`Room ${roomId} not found`, "ROOM_NOT_FOUND");
    if (agentId === this.peerId && room.owner !== this.peerId) {
      return this.leaveRemoteRoom(roomId, room.owner);
    }

    this.bump(room);
    this.recordMemberOp(room, "member", "leave", agentId);
    this.refreshMembership(room);
    this.rooms.set(roomId, room);

    const agent = this.agents.get(agentId);
    if (agent) {
      agent.subscribedRooms = agent.subscribedRooms.filter(
        (id) => id !== roomId,
      );
      this.agents.set(agentId, agent);
      await this.broadcastPatch({ type: "agent_upsert", agent });
    }

    await this.broadcastPatch({ type: "room_upsert", room });
    await this.deliverToRoom(roomId, {
      type: "member_left",
      room: roomId,
      agent: agentId,
    });

    // Notify federated links if the room is federated
    if (room.federated) {
      await this.federation.broadcastRoomLeave(roomId, agentId);
    }

    if (room.members.length === 0 && room.owner === agentId) {
      await this.destroyRoom(roomId, agentId);
    }
  }

  /**
   * The remote-leave path: roomPath names a room this store is a member of but does not own, so leaving for real means telling the owner over a real, wire-authenticated room.leave rather than mutating a local Room record nobody else reads. Also declineInvite's own mechanism (P3.8): the moment a target receives an invite (handleRoomInvite), it already holds a real, persisted room:member token exactly as if it had joined -- declining is simply leaving before ever really participating, and the owner's own receiving side (handleRoomLeave) tells the two cases apart by checking its own membership/invited lists, not by a separate verb. reason rides room.leave's own open extension tail so the owner can still surface a real decline reason without a second wire shape.
   */
  private async leaveRemoteRoom(
    roomPath: string,
    ownerId: string,
    reason?: string,
  ): Promise<void> {
    const { slot } = this.requireIdentity();
    const token = loadRoomTokens(slot)[roomPath];
    if (token === undefined) {
      throw new CommsError(
        `No room:member token for ${roomPath}`,
        "NOT_MEMBER",
      );
    }
    const params: Record<string, unknown> = {
      verb: "room.leave",
      ...(reason !== undefined ? { reason } : {}),
    };
    const outcome = await this.requireTransport().sendRoomRequest(
      ownerId,
      { verb: ROOM_MEMBER_CAPABILITY, params },
      { kind: "room", path: roomPath },
      token,
    );
    if (outcome.result !== "ok") {
      throw new CommsError(
        `Leaving ${roomPath} failed (${outcome.code})`,
        "LEAVE_FAILED",
      );
    }
    deleteRoomToken(slot, roomPath);
    this.rooms.delete(roomPath);
    this.messages.delete(roomPath);
  }

  /**
   * Invites targetId to roomId, over a real, wire-authenticated room.invite (P3.8): mints a fresh room:member grant for the target, records its own token-id the same way admitRoomJoin does (kickFromRoom can revoke an invited member's own grant exactly as it can a joined one), and pushes the grant to the target directly in the invite request itself -- room.invite is deliberately ungated (the room's own owner needs no capability to invite, per core/room's design), so the target's own verification of the embedded token is what proves this invite is genuine, not anything about the connection it arrived on. Retains the local CRDT invited-list bookkeeping (still this store's own record of who it has invited) but no longer broadcasts it: the target learns of the invite from the real request, not a mesh-wide patch.
   */
  async inviteToRoom(
    roomId: string,
    targetId: string,
    inviterId: string,
  ): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room)
      throw new CommsError(`Room ${roomId} not found`, "ROOM_NOT_FOUND");
    if (room.owner !== inviterId)
      throw new CommsError("Only the room owner can invite", "NOT_OWNER");

    this.bump(room);
    if (!room.invited.includes(targetId) && !room.members.includes(targetId)) {
      this.recordMemberOp(room, "invited", "join", targetId);
    }
    this.refreshMembership(room);
    this.rooms.set(roomId, room);

    const { identity, clock, slot } = this.requireIdentity();
    const tokenId = randomId();
    const verdict = await mintCapabilityToken({
      identity,
      clock,
      tokenId,
      bearer: deviceIdFromHex(targetId),
      capability: ROOM_MEMBER_CAPABILITY,
      scope: { kind: "room", path: roomId },
      expires: clock.now() + ROOM_TOKEN_LIFETIME_MS,
      delegationsRemaining: 0,
    });
    if (!verdict.ok) {
      throw new CommsError(
        `Failed to mint an invite grant for ${targetId}`,
        "MINT_FAILED",
      );
    }
    saveIssuedRoomGrant(slot, roomId, targetId, tokenId);

    const inviter = this.agents.get(inviterId);
    const params: Record<string, unknown> = {
      verb: "room.invite",
      invitee: deviceIdFromHex(targetId),
      token: verdict.token,
      ...MeshStore.roomStateExtension(room),
      ...(inviter !== undefined
        ? MeshStore.inviterAgentExtension(inviter)
        : {}),
    };
    const outcome = await this.requireTransport().sendRoomRequest(
      targetId,
      { verb: ROOM_MEMBER_CAPABILITY, params },
      { kind: "room", path: roomId },
    );
    if (outcome.result !== "ok") {
      throw new CommsError(
        `Invite to ${targetId} for ${roomId} failed (${outcome.code})`,
        "INVITE_FAILED",
      );
    }
  }

  /**
   * Declines a pending invite, over the same real room.leave request leaveRemoteRoom already sends for an actual leave (P3.8): the moment this store received the invite (handleRoomInvite), it already holds a real, persisted room:member token, so declining before ever really participating is simply leaving early -- the owner's own receiving side (handleRoomLeave) tells the two cases apart from its own membership/invited lists, not from a separate verb. Uses parseRoomPath rather than any locally cached Room record to find the owner to leave, since handleRoomInvite never constructs one -- there is nothing here to read a room.owner field off in the first place.
   */
  async declineInvite(
    roomId: string,
    agentId: string,
    reason: string,
  ): Promise<void> {
    // Every real caller declines on its own behalf (tool.ts always passes ctx.agentId, which for a real bridge process is always this.peerId, per the design's own "one bridge is one agent is one device" organising fact) -- there is no remote-decline-on-someone-else's-behalf mechanism, so a mismatch here means the caller itself is confused about whose invite it is declining.
    if (agentId !== this.peerId) {
      throw new CommsError(
        `Cannot decline an invite on behalf of ${agentId}`,
        "NOT_SELF",
      );
    }
    const parsed = parseRoomPath(roomId);
    if (parsed.kind !== "owner-named") {
      throw new CommsError(`Room ${roomId} not found`, "ROOM_NOT_FOUND");
    }
    return this.leaveRemoteRoom(roomId, parsed.owner, reason);
  }

  /**
   * Kicks targetId from roomId. Beyond the legacy CRDT membership removal (retired in P3.8 along with every other non-message broadcastPatch caller), this revokes the member's own room:member grant for real: mints a revocation-entry for the token-id this identity recorded when it admitted them (admitRoomJoin's own saveIssuedRoomGrant), records it in this store's own RevocationView immediately (so this identity's own future verifications see the kick without waiting on its own gossip), and announces it to every connected peer so each one's independent verification of the target's token -- not just this room's owner -- also starts failing as "revoked" from here on. Silently skips the revocation step (kick still happens; only the token-side enforcement doesn't) when no issued-grant record exists for this member, e.g. a grant predating this bookkeeping.
   */
  /**
   * Revokes memberId's own room:member grant for roomId for real, if this identity ever recorded issuing one: mints a revocation-entry for its token-id, records it in this store's own RevocationView immediately, announces it to every connected peer, and forgets the issued-grant record (a later re-admission mints and records a genuinely fresh one rather than leaving a stale entry alongside it). Silently does nothing when no issued-grant record exists (a grant predating this bookkeeping, or a member who was never actually admitted a token at all) -- shared by kickFromRoom (owner-initiated) and handleRoomLeave (member-initiated, including a decline).
   */
  private async revokeMemberGrant(
    roomId: string,
    memberId: string,
  ): Promise<void> {
    const { identity, clock, slot, revocation } = this.requireIdentity();
    const tokenId = loadIssuedRoomGrant(slot, roomId, memberId);
    if (tokenId === undefined) return;
    const entry = await mintRevocationEntry({
      identity,
      tokenId,
      revokedAt: clock.now(),
    });
    await revocation.record(entry, { identity });
    await this.requireTransport().broadcastRevocation([entry]);
    deleteIssuedRoomGrant(slot, roomId, memberId);
  }

  async kickFromRoom(
    roomId: string,
    targetId: string,
    kickerId: string,
  ): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room)
      throw new CommsError(`Room ${roomId} not found`, "ROOM_NOT_FOUND");
    if (room.owner !== kickerId)
      throw new CommsError("Only the room owner can kick", "NOT_OWNER");

    await this.revokeMemberGrant(roomId, targetId);

    this.bump(room);
    this.recordMemberOp(room, "member", "leave", targetId);
    this.recordMemberOp(room, "invited", "leave", targetId);
    this.refreshMembership(room);
    this.rooms.set(roomId, room);
    await this.broadcastPatch({ type: "room_upsert", room });
  }

  async destroyRoom(roomId: string, agentId: string): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room)
      throw new CommsError(`Room ${roomId} not found`, "ROOM_NOT_FOUND");
    if (room.owner !== agentId)
      throw new CommsError("Only the room owner can destroy", "NOT_OWNER");

    for (const memberId of room.members) {
      const member = this.agents.get(memberId);
      if (member) {
        member.subscribedRooms = member.subscribedRooms.filter(
          (id) => id !== roomId,
        );
        this.agents.set(memberId, member);
        await this.broadcastPatch({ type: "agent_upsert", agent: member });
      }
    }

    this.rooms.delete(roomId);
    this.messages.delete(roomId);
    await this.broadcastPatch({ type: "room_delete", roomId });
  }

  // -----------------------------------------------------------------------
  // CommsStore — Messages
  // -----------------------------------------------------------------------

  /**
   * Sends a room message via a real, wire-authenticated room.send fan-out (P3.5): one directed request per member, each carrying this sender's own persisted room:member token, rather than the legacy broadcastPatch's full-state replication. A member unreachable right now is queued for retry (see sendRoomRequestToMember/flushPendingRoomRequests) instead of blocking or failing the whole send -- delivery to any one recipient is independent of every other.
   */
  async sendRoomMessage(
    roomId: string,
    from: string,
    content: string,
    replyTo?: string,
    streamingBehavior?: StreamingBehavior,
  ): Promise<RoomMessage> {
    const room = this.rooms.get(roomId);
    if (!room)
      throw new CommsError(`Room ${roomId} not found`, "ROOM_NOT_FOUND");
    if (!room.members.includes(from))
      throw new CommsError(`Not a member of ${roomId}`, "NOT_MEMBER");

    const { slot, clock } = this.requireIdentity();
    const token = loadRoomTokens(slot)[roomId];
    if (token === undefined) {
      throw new CommsError(`No room:member token for ${roomId}`, "NOT_MEMBER");
    }

    const messageId = randomId();
    const id = bytesToHex(messageId);
    const message: RoomMessage = {
      id,
      from,
      room: roomId,
      content,
      timestamp: new Date().toISOString(),
      readBy: [from],
      ...(replyTo !== undefined && { replyTo }),
      ...(streamingBehavior !== undefined && { streamingBehavior }),
    };

    const arr = this.messages.get(roomId) ?? [];
    arr.push(message);
    this.messages.set(roomId, arr);

    // Forward to federated links if the room is federated
    if (room.federated) {
      await this.federation.forwardRoomMessage(roomId, message);
    }

    const params: Record<string, unknown> = {
      verb: "room.send",
      "message-id": messageId,
      "sent-at": clock.now(),
      text: content,
      ...(replyTo !== undefined && {
        refs: [{ id: bytesFromHex(replyTo), relation: "reply" }],
      }),
      ...(streamingBehavior !== undefined && {
        "streaming-behavior": streamingBehavior,
      }),
    };

    for (const memberId of room.members) {
      if (memberId !== from) {
        await this.sendRoomRequestToMember(memberId, roomId, token, params);
      }
    }

    return message;
  }

  async readRoomMessages(
    roomId: string,
    since?: string,
  ): Promise<RoomMessage[]> {
    await Promise.resolve();
    const arr = this.messages.get(roomId) ?? [];
    if (!since) return [...arr];
    return arr.filter((m) => m.timestamp > since);
  }

  // -----------------------------------------------------------------------
  // CommsStore — DMs
  // -----------------------------------------------------------------------

  /**
   * Sends a DM via the same wire-authenticated room.send fan-out sendRoomMessage uses (P3.5): a DM is just a dm-shaped room path with exactly one other member, so it rides the identical mechanism rather than a separate one. Self-DM is the one exception -- a purely local scratchpad note that never leaves the process, so it needs no token and no wire round trip at all.
   */
  async sendDm(
    from: string,
    to: string,
    content: string,
    streamingBehavior?: StreamingBehavior,
  ): Promise<DmMessage> {
    if (to !== from) {
      const recipient = this.agents.get(to);
      if (!recipient)
        throw new CommsError(`Agent ${to} not found`, "AGENT_NOT_FOUND");
      if (recipient.visibility === "ghost")
        throw new CommsError(`Cannot DM agent ${to}`, "AGENT_NOT_FOUND");
    }

    const messageId = randomId();
    const id = bytesToHex(messageId);
    const message: DmMessage = {
      id,
      from,
      to,
      content,
      timestamp: new Date().toISOString(),
      readBy: [from],
      ...(streamingBehavior !== undefined && { streamingBehavior }),
    };

    // Self-DM is a purely local scratchpad note -- it never leaves the process, so it needs no room-path and dmRoomPath's own a===b refusal (a path naming the same device twice is not a valid DM path at all) correctly does not apply here.
    const key = to === from ? `self:${from}` : dmRoomPath(from, to);
    const arr = this.dms.get(key) ?? [];
    arr.push(message);
    this.dms.set(key, arr);

    if (to !== from) {
      const { slot, clock } = this.requireIdentity();
      const token = loadRoomTokens(slot)[key];
      if (token === undefined) {
        throw new CommsError(`No room:member token for ${key}`, "NOT_MEMBER");
      }
      const params: Record<string, unknown> = {
        verb: "room.send",
        "message-id": messageId,
        "sent-at": clock.now(),
        text: content,
        ...(streamingBehavior !== undefined && {
          "streaming-behavior": streamingBehavior,
        }),
      };
      await this.sendRoomRequestToMember(to, key, token, params);
    }

    return message;
  }

  // -----------------------------------------------------------------------
  // CommsStore — Delivery
  // -----------------------------------------------------------------------

  async deliver(agentId: string, event: DeliveryEvent): Promise<void> {
    await this.deliverLocallyAndBroadcast(agentId, event);
  }

  async drainDelivery(agentId: string): Promise<DeliveryEvent[]> {
    await Promise.resolve();
    const events = this.deliveryQueues.get(agentId) ?? [];
    this.deliveryQueues.set(agentId, []);

    // Auto-mark messages as read — drain bridges consume on tool call
    for (const event of events) {
      if (event.type === "room_message") {
        await this.markRead(event.message.id, agentId, event.message.room);
      } else if (event.type === "dm") {
        await this.markRead(event.message.id, agentId);
      }
    }

    return events;
  }

  // -----------------------------------------------------------------------
  // Stale agent cleanup (coordinator only)
  // -----------------------------------------------------------------------

  private startStaleCheck(): void {
    if (this.staleCheckTimer) return;
    this.staleCheckTimer = setInterval(() => {
      void this.probeStaleAgents();
    }, 5000);
  }

  private stopStaleCheck(): void {
    if (this.staleCheckTimer) {
      clearInterval(this.staleCheckTimer);
      this.staleCheckTimer = undefined;
    }
  }

  private async probeStaleAgents(): Promise<void> {
    const deadIds: string[] = [];

    for (const [id, agent] of this.agents) {
      if (agent.status !== "active") continue;
      if (!this.isProcessAlive(agent.pid)) {
        deadIds.push(id);
      }
    }

    for (const id of deadIds) {
      const agent = this.agents.get(id);
      if (agent) {
        agent.status = "offline";
        this.agents.set(id, agent);
        await this.notifyRoomsOfStatus(id, "offline");
      }
      await this.broadcastPatch({ type: "agent_offline", agentId: id });
      this.peerInfo.delete(id);
    }

    // Also purge long-offline agents to prevent indefinite accumulation
    const offlineThreshold = Date.now() - 30 * 60 * 1000; // 30 minutes
    const purgeIds: string[] = [];
    for (const [id, agent] of this.agents) {
      if (agent.status !== "offline") continue;
      const startedAt = new Date(agent.startedAt).getTime();
      if (startedAt < offlineThreshold) {
        purgeIds.push(id);
      }
    }
    for (const id of purgeIds) {
      this.agents.delete(id);
      this.peerInfo.delete(id);
      this.identityCache.delete(id);
      this.deliveryQueues.delete(id);
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
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

  fedTrust(fingerprint: string): Promise<void> {
    this.federation.addTrustedFingerprint(fingerprint);
    return Promise.resolve();
  }

  fedUntrust(fingerprint: string): Promise<void> {
    this.federation.removeTrustedFingerprint(fingerprint);
    return Promise.resolve();
  }

  fedTrustedFingerprints(): string[] {
    return this.federation.listTrustedFingerprints();
  }

  fedListen(host: string, port: number): Promise<void> {
    return this.federation.listen(host, port);
  }

  fedStopListening(): Promise<void> {
    return this.federation.stopListening();
  }

  // -----------------------------------------------------------------------
  // Federation callbacks (inbound from remote meshes)
  // -----------------------------------------------------------------------

  private async handleFedAgentVisible(agent: AgentIdentity): Promise<void> {
    // Store remote agent with a prefixed ID to avoid collisions with local agents
    const remoteId = `fed:${agent.id}@${agent.harness}`;
    const remoteAgent: AgentIdentity = {
      ...agent,
      id: remoteId,
      tags: [...agent.tags, "federated"],
    };
    this.agents.set(remoteId, remoteAgent);
    await this.broadcastPatch({ type: "agent_upsert", agent: remoteAgent });
  }

  private async handleFedAgentGone(agentId: string): Promise<void> {
    // The agentId comes from the remote mesh — we need to find the prefixed version
    const prefix = `fed:${agentId}@`;
    for (const [localId, agent] of this.agents) {
      if (localId.startsWith(prefix)) {
        agent.status = "offline";
        this.agents.set(localId, agent);
        await this.broadcastPatch({ type: "agent_offline", agentId: localId });
        break;
      }
    }
  }

  private async handleFedRoomMessage(
    roomId: string,
    message: RoomMessage,
  ): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room?.federated) return;

    // Store the message locally
    const arr = this.messages.get(roomId) ?? [];
    arr.push(message);
    this.messages.set(roomId, arr);

    // Deliver to all local room members
    for (const memberId of room.members) {
      await this.deliverLocallyAndBroadcast(memberId, {
        type: "room_message",
        message,
      });
    }
  }

  private async handleFedRoomJoin(
    roomId: string,
    agentId: string,
    _agentName: string,
  ): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room?.federated) return;

    // Create a shadow agent ID for the remote agent
    const remoteId = `fed:${agentId}`;

    if (!room.members.includes(remoteId)) {
      this.bump(room);
      this.recordMemberOp(room, "member", "join", remoteId);
      this.refreshMembership(room);
      this.rooms.set(roomId, room);
      await this.broadcastPatch({ type: "room_upsert", room });
    }

    // Notify local members
    await this.deliverToRoom(
      roomId,
      {
        type: "member_joined",
        room: roomId,
        agent: remoteId,
      },
      remoteId,
    );
  }

  private async handleFedRoomLeave(
    roomId: string,
    agentId: string,
  ): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room?.federated) return;

    const remoteId = `fed:${agentId}`;
    this.bump(room);
    this.recordMemberOp(room, "member", "leave", remoteId);
    this.refreshMembership(room);
    this.rooms.set(roomId, room);
    await this.broadcastPatch({ type: "room_upsert", room });

    await this.deliverToRoom(roomId, {
      type: "member_left",
      room: roomId,
      agent: remoteId,
    });
  }

  private getVisibleAgentsForFed(): AgentIdentity[] {
    const result: AgentIdentity[] = [];
    for (const agent of this.agents.values()) {
      // Only broadcast agents that belong to this mesh (not federated)
      // and are visible
      if (agent.visibility === "visible" && !agent.id.startsWith("fed:")) {
        result.push(agent);
      }
    }
    return result;
  }

  private getFederatedRoomMembershipsForFed(): Map<string, string[]> {
    const result = new Map<string, string[]>();
    for (const [roomId, room] of this.rooms) {
      if (room.federated) {
        // Only include local members (not federated ones)
        const localMembers = room.members.filter((m) => !m.startsWith("fed:"));
        result.set(roomId, localMembers);
      }
    }
    return result;
  }

  // -----------------------------------------------------------------------
  // Shutdown
  // -----------------------------------------------------------------------

  async shutdown(): Promise<void> {
    this.isShutDown = true;
    // Clear any pending markRead timers so they don't fire after the
    // transport is shut down (which would attempt sends on closed sockets)
    // or keep the event loop alive after process.exit().
    for (const timer of this.pendingMarkReadTimers) {
      clearTimeout(timer);
    }
    this.pendingMarkReadTimers.length = 0;

    const agent = this.agents.get(this.peerId);
    if (agent) {
      agent.status = "offline";
      await this.broadcastPatch({
        type: "agent_offline",
        agentId: this.peerId,
      });
    }

    this.stopStaleCheck();
    await this.federation.shutdown();
    await this.requireTransport().shutdown();
  }
}

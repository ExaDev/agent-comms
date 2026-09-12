/**
 * WireMeshTransport — MeshTransport implemented over wire-mesh-core, carrying the existing MeshMessage union as an opaque payload rather than inventing new wire semantics. This is the P2 substrate swap's own deliverable: MeshStore, CommsTool, and every existing agent/room/message behaviour above the transport are completely unaffected -- only how bytes move between peers changes.
 *
 * Every agent-comms MeshMessage rides as a single namespaced manage-command verb (FRAME_VERB) under one flat scope (FRAME_SCOPE); the message itself is carried opaquely in the command's own params.message field. This needs no spec/CDDL change: manage-command-params is already an open `{* tstr => any}` socket for exactly this purpose.
 *
 * Peer identity is authenticated at the transport layer, not asserted on the wire: createTlsTransport verifies a peer's presented certificate cryptographically and exposes the result as Connection.peerDeviceId before any MeshMessage is ever exchanged, which is what lets the `pong` self-identification message retire entirely -- there is nothing left for it to prove that the connection itself hasn't already proven.
 *
 * connect_request's accept/reject flow maps onto sendManageRequest's own request/response round trip directly, rather than a separate pair of connect_accepted/connect_rejected messages: manage-request-frame already tolerates arbitrary latency between a request and its response, so "waiting for a human to approve" is simply a manage-response that hasn't been sent yet, not a protocol gap needing its own mechanism. connect_request therefore holds its own IncomingManageRequest open (rather than responding immediately) until acceptConnection/rejectConnection is actually called.
 */

import { createTlsTransport } from "wire-mesh-core/adapters/tls-transport";
import {
  acceptMeshSession,
  type AcceptedMeshSession,
  type IncomingManageRequest,
  type ManageOutcome,
} from "wire-mesh-core/domain/mesh-session";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import type {
  CapabilityScope,
  CapabilityToken,
  ManageCommand,
  RevocationEntry,
} from "wire-mesh-core/generated/protocol";
import type {
  Connection,
  Listener,
  Transport,
} from "wire-mesh-core/ports/transport";
import type { MeshMessage, PeerInfo } from "./wire-protocol.js";
import type {
  ConnectionHandle,
  ListenerInfo,
  ListenerPolicy,
  MeshTransport,
  TransportEvents,
} from "./transport.js";
import type { PeerIdentity } from "./identity.js";
import { toIdentityPort } from "./wire-mesh-identity.js";
import { nanoid } from "./nanoid.js";
import {
  createRoomRouter,
  extractMessage,
  type RoomRouter,
  type RoomVerbHandler,
} from "./room-router.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COORDINATOR_HOST = "127.0.0.1";

/** This project's own namespaced domain (registrant "exadev.io", local name "agent-comms-v1"), matching namespaced-domain-id's "<registrant>/<local-name>" shape -- registry/core-domains.md's own recommended pattern for a third party. Exported for test use only: a security test simulating a hostile client that skips connect_request needs to construct a well-formed frame under the same domain/verb/scope this transport itself listens on, rather than duplicating these as separately-maintained magic strings that could silently drift from the real values. */
export const DOMAIN = "exadev.io/agent-comms-v1";

/** One verb for the entire MeshMessage union: this phase carries every message opaquely rather than modelling each arm as its own verb, which is core/room's own job once P3 gives this substrate real room semantics. */
export const FRAME_VERB = "exadev.io/agent-comms-v1:frame";

/** No finer-grained authorisation model exists above "you're an approved member of this mesh" at this phase -- once a session is past the quarantine gate (see handleAcceptedConnection), it's trusted for every message this domain carries. */
export const FRAME_SCOPE: Readonly<CapabilityScope> = {
  kind: "agent-comms-mesh",
};

// ---------------------------------------------------------------------------
// Message carriage
// ---------------------------------------------------------------------------

export function buildCommand(message: MeshMessage): ManageCommand {
  return { verb: FRAME_VERB, params: { message } };
}

/** Reads the port a listener actually bound, from its own reported address -- never the port it was asked to bind, which is 0 whenever the caller wanted the OS to assign a free one. Bookkeeping that stores the requested port instead silently reports 0 for every OS-assigned listener. */
function listenerPort(listener: Readonly<Listener>): number {
  const port = listener.address.split(":").pop();
  return port === undefined ? 0 : Number(port);
}

// ---------------------------------------------------------------------------
// Internal session bookkeeping
// ---------------------------------------------------------------------------

/** A human decision on a connect_request: "accept" resumes the still-blocked consumeQuarantined loop as a fully trusted session; "reject" (also used when the requester disconnects before a decision is made) unblocks it to close instead. */
type ConnectionDecision = "accept" | "reject";

interface PendingConnection {
  respond: IncomingManageRequest["respond"];
  dataPort: number;
  name: string;
  fingerprint: string;
  policy: ListenerPolicy | undefined;
  /** Held so acceptConnection can trackSession it synchronously, before firing onIntroduction -- that event's own handler (mesh-store's handleIntroduction) sends a reply on this same handle immediately, which needs peerSessions already populated. Waiting for consumeQuarantined's own suspended loop to resume and do it would race: resolve() below only wakes that loop on a later microtask tick, after onIntroduction has already fired. */
  session: AcceptedMeshSession;
  /** Settles the Promise consumeQuarantined is blocked on for this connect_request -- the mechanism by which acceptConnection/rejectConnection resume a loop suspended mid-iteration, without ever needing to re-obtain (and so needing to reason about the identity of) a second iterator over the same session's incomingManageRequests. */
  resolve: (decision: ConnectionDecision) => void;
}

interface TrackedListener {
  listener: Listener;
  policy: ListenerPolicy;
  host: string;
  port: number;
  isDefault: boolean;
}

// ---------------------------------------------------------------------------
// WireMeshTransport
// ---------------------------------------------------------------------------

export class WireMeshTransport implements MeshTransport {
  private readonly wireTransport: Transport;
  private readonly events: TransportEvents;
  private readonly identityReady: Promise<
    Awaited<ReturnType<typeof toIdentityPort>>
  >;

  private _dataPort = 0;
  private _isCoordinator = false;
  private shutDown = false;

  /** A method call, not a direct property read -- deliberately, so TS's control-flow narrowing (which does track `this.shutDown` as staying false for the rest of a function once an early `if (this.shutDown) return` has passed, with no awareness that an `await` in between gave a concurrent shutdown() call the chance to flip it) doesn't treat every later re-check in the same async function as unreachable. Each of these re-checks is real: shutdown() can run at any time this function is suspended on an await. */
  private isShuttingDown(): boolean {
    return this.shutDown;
  }

  // -- Data server (accepts data connections from already-known peers) --
  private dataListener: Listener | undefined;

  // -- Coordinator listeners (the well-known bootstrap port, plus any additional adapters addListener creates) --
  private coordinatorListeners = new Map<string, TrackedListener>();
  private defaultListenerId: string | undefined;

  // -- The session dialled via connectToCoordinator, when this instance is not itself the coordinator --
  private coordinatorSession: AcceptedMeshSession | undefined;

  // -- Every live session, keyed by the peer's authenticated device-id hex (== ConnectionHandle.id) -- covers coordinator-client, coordinator-accepted, and peer data sessions alike, since send()/broadcast() must reach whichever kind of session a peer happens to be reachable through. A single-slot-per-key map by construction: mesh formation genuinely establishes TWO independent sessions to the same peer (see the dataDials comment below), and the second one registered here simply overwrites the first as far as addressing goes -- fine for send()/broadcast() (either socket reaches the same peer), but NOT fine for shutdown, which must close every live session regardless of whether it's still reachable through this map. allSessions below exists specifically so shutdown never leaks the one this map's overwrite silently stopped tracking.
  private peerSessions = new Map<string, AcceptedMeshSession>();

  // -- Every live session this transport has ever created, accepted or dialled, for shutdown's own use only -- never used for addressing (peerSessions is), so it never loses track of one session to another sharing the same peer id.
  private allSessions = new Set<AcceptedMeshSession>();

  /** Registers a session in both peerSessions (addressing -- last one in for a given peer wins) and allSessions (shutdown -- every session, always). */
  private trackSession(key: string, session: AcceptedMeshSession): void {
    this.peerSessions.set(key, session);
    this.allSessions.add(session);
  }

  // -- Peers this side has dialled via connectToPeer specifically (in flight or established) -- deliberately separate from peerSessions, which also holds sessions this side reached the SAME peer through for an unrelated reason (most concretely, the coordinator-client session connectToCoordinator opens to the coordinator's own device-id). Mesh formation deliberately establishes a second, independent connection in each direction so each side's own acceptor can push its own state (see mesh-store.ts's own handlePeerConnected), so connectToPeer's "don't dial twice" guard must not be satisfied by an unrelated session that merely happens to share the same peer ID.
  private dataDials = new Set<string>();

  // -- connect_request frames awaiting a human accept/reject decision, keyed by the requester's device-id hex --
  private pendingConnections = new Map<string, PendingConnection>();

  // -- The single consumer of every approved session's incomingManageRequests, once quarantine (if any) is past. Owns verb dispatch (the legacy opaque frame, plus whichever real core/room verbs later phases register handlers for) -- this transport itself no longer decodes or routes a MeshMessage at all beyond handing a session off here.
  private readonly roomRouter: RoomRouter;

  constructor(
    events: TransportEvents,
    identity: Readonly<PeerIdentity>,
    roomVerbHandlers?: Partial<Record<string, RoomVerbHandler>>,
  ) {
    this.events = events;
    this.wireTransport = createTlsTransport({
      certificatePem: identity.certificate,
      privateKeyPem: identity.privateKey,
    });
    this.identityReady = toIdentityPort(identity);
    this.roomRouter = createRoomRouter({
      events,
      ...(roomVerbHandlers !== undefined ? { handlers: roomVerbHandlers } : {}),
    });
  }

  // -- Public getters --

  get dataPort(): number {
    return this._dataPort;
  }

  get isCoordinator(): boolean {
    return this._isCoordinator;
  }

  get hasCoordinatorConnection(): boolean {
    return this.coordinatorSession !== undefined;
  }

  // -----------------------------------------------------------------------
  // Connection acceptance -- shared by every listener (coordinator or data)
  // -----------------------------------------------------------------------

  private async handleAcceptedConnection(
    connection: Readonly<Connection>,
    policy: ListenerPolicy | undefined,
    fireOnPeerConnected: boolean,
    requiresApproval: boolean,
  ): Promise<void> {
    if (this.shutDown) {
      await connection.close();
      return;
    }
    const peerDeviceId = connection.peerDeviceId;
    if (peerDeviceId === undefined) {
      // No certificate presented at all -- nothing to authenticate this peer against.
      await connection.close();
      return;
    }
    const deviceIdHex = deviceIdToHex(peerDeviceId);
    const identity = await this.identityReady;
    const session = await acceptMeshSession(connection, identity, [DOMAIN]);
    if (this.isShuttingDown()) {
      await session.close();
      return;
    }
    // ConnectionHandle.policy is `?: ListenerPolicy`, not `?: ListenerPolicy | undefined` -- under exactOptionalPropertyTypes these are genuinely different types, so the key must be entirely absent rather than present-with-undefined-value when this listener has no policy of its own.
    const handle: ConnectionHandle = {
      id: deviceIdHex,
      ...(policy !== undefined ? { policy } : {}),
    };

    if (requiresApproval) {
      // A listener a stranger can dial cold (the coordinator port, or any addListener-created listener) must not hand out full routing on the strength of a TLS handshake alone -- that only proves which key the far side holds, never that a human has approved them as a mesh member. Quarantine every request from this session until it's either an `introduce` (the pre-existing, ungated coordinator-handoff path, unchanged from before this substrate swap) or an approved `connect_request`.
      this.allSessions.add(session);
      this.consumeQuarantined(session, handle);
      this.watchForDisconnect(session, handle, deviceIdHex);
      return;
    }

    this.trackSession(deviceIdHex, session);
    if (fireOnPeerConnected) {
      const info: PeerInfo = {
        id: deviceIdHex,
        port: 0,
        startedAt: new Date().toISOString(),
      };
      this.events.onPeerConnected(handle, info);
    }

    this.consumeIncoming(session, handle);
    this.watchForDisconnect(session, handle, deviceIdHex);
  }

  /** Reads a not-yet-trusted session's requests until it's promoted (an `introduce`, handled and trusted immediately, matching the pre-existing coordinator-handoff trust boundary) or a `connect_request` arrives, at which point this same loop iteration blocks on the human decision Promise stored in pendingConnections -- resumed in place by acceptConnection/rejectConnection (or by watchForDisconnect, if the requester disconnects first) -- rather than ever stopping and later re-entering the session's incomingManageRequests from a second call, which would require assuming a fresh access yields a distinct, independently-advancing iterator rather than resuming the one already in progress. Anything else arriving before introduce/connect_request is a protocol violation from an unapproved peer and is refused and closed rather than routed. */
  private consumeQuarantined(
    session: AcceptedMeshSession,
    handle: ConnectionHandle,
  ): void {
    void (async () => {
      let approved = false;
      for await (const request of session.incomingManageRequests) {
        if (this.shutDown) break;
        if (approved) {
          await this.roomRouter.handleRequest(request, handle);
          continue;
        }
        const message = extractMessage(request.command);
        if (message === undefined) {
          await request.respond({ result: "ok" }).catch(() => undefined);
          continue;
        }
        if (message.method === "introduce") {
          this.trackSession(handle.id, session);
          this.events.onIntroduction(handle, {
            peerId: handle.id,
            dataPort: message.dataPort,
          });
          await request.respond({ result: "ok" }).catch(() => undefined);
          approved = true;
          continue;
        }
        if (message.method === "connect_request") {
          // Held open deliberately -- see this file's own header comment. Answered later by acceptConnection/rejectConnection, not here.
          const decision = await new Promise<ConnectionDecision>((resolve) => {
            this.pendingConnections.set(handle.id, {
              respond: request.respond,
              dataPort: message.dataPort,
              name: message.name,
              fingerprint: message.fingerprint,
              policy: handle.policy,
              session,
              resolve,
            });
            this.events.onConnectionRequest(handle, {
              peerId: handle.id,
              dataPort: message.dataPort,
              name: message.name,
              fingerprint: message.fingerprint,
            });
          });
          if (decision === "reject") {
            // Rejection can arrive via rejectConnection (session still open) or via shutdown/disconnect (session already closing) -- catch rather than assume which.
            await session.close().catch(() => undefined);
            return;
          }
          // acceptConnection has already called trackSession synchronously, before firing onIntroduction -- nothing left to do here beyond trusting subsequent requests on this same session.
          approved = true;
          continue;
        }
        // Any other message before introduce/connect_request is a protocol violation from an unapproved peer -- refuse and terminate rather than route it.
        await request
          .respond({ result: "error", code: "not_approved" })
          .catch(() => undefined);
        await session.close().catch(() => undefined);
        return;
      }
    })();
  }

  /** Delegates the whole post-approval drain loop to roomRouter -- this transport no longer decodes or routes a MeshMessage itself, only hands the session off. Also starts this session's own independent revocationAnnouncements drain, since a gossiped revocation is not a manage-request and has no verb for roomRouter to dispatch. */
  private consumeIncoming(
    session: AcceptedMeshSession,
    handle: ConnectionHandle,
  ): void {
    this.roomRouter.drainSession(session, handle);
    this.drainRevocationAnnouncements(session);
  }

  /** Reads every revocation-entry this session's peer announces, for as long as the session lives, handing each one to MeshStore via onRevocationAnnounce -- one call per entry, matching revocationAnnouncements' own per-entry flattening of a revocation-announce frame's entries array. */
  private drainRevocationAnnouncements(session: AcceptedMeshSession): void {
    void (async () => {
      for await (const entry of session.revocationAnnouncements) {
        this.events.onRevocationAnnounce(entry);
      }
    })();
  }

  private watchForDisconnect(
    session: AcceptedMeshSession,
    handle: ConnectionHandle,
    deviceIdHex: string,
  ): void {
    void (async () => {
      for await (const event of session.events) {
        if (event.state.status === "closed") {
          const wasTracked = this.peerSessions.get(deviceIdHex) === session;
          if (wasTracked) this.peerSessions.delete(deviceIdHex);
          this.allSessions.delete(session);
          // A requester disconnecting before a human decides must unblock consumeQuarantined's own still-suspended loop iteration -- otherwise that promise, and the closure awaiting it, never settle.
          this.pendingConnections.get(deviceIdHex)?.resolve("reject");
          this.pendingConnections.delete(deviceIdHex);
          // A no-op when this session was never a connectToPeer dial (e.g. the coordinator-client or an accepted connection) -- Set.delete on an absent key is always safe.
          this.dataDials.delete(deviceIdHex);
          if (wasTracked && !this.shutDown) {
            this.events.onPeerDisconnected(handle);
          }
          return;
        }
      }
    })();
  }

  // -----------------------------------------------------------------------
  // MeshTransport -- Data server
  // -----------------------------------------------------------------------

  async startDataServer(): Promise<void> {
    this.dataListener = await this.wireTransport.listen(
      `${COORDINATOR_HOST}:0`,
      (connection) => {
        void this.handleAcceptedConnection(connection, undefined, true, false);
      },
    );
    this._dataPort = listenerPort(this.dataListener);
  }

  // -----------------------------------------------------------------------
  // MeshTransport -- Coordinator connection (client side)
  // -----------------------------------------------------------------------

  async connectToCoordinator(
    host: string,
    port: number,
    peerId: string,
    dataPort: number,
  ): Promise<void> {
    const connection = await this.wireTransport.connect(
      `${host}:${String(port)}`,
    );
    const identity = await this.identityReady;
    const session = await acceptMeshSession(connection, identity, [DOMAIN]);
    this.coordinatorSession = session;
    const coordinatorDeviceId = connection.peerDeviceId;
    if (coordinatorDeviceId !== undefined) {
      const handle: ConnectionHandle = {
        id: deviceIdToHex(coordinatorDeviceId),
      };
      this.trackSession(handle.id, session);
      this.consumeIncoming(session, handle);
      this.watchForDisconnect(session, handle, handle.id);
    }
    // Fire-and-forget, matching the previous transport's own contract: this resolves once the introduction is sent, not once a response arrives -- peer_list/peer_joined/become_coordinator arrive asynchronously via the normal dispatch path above, independent of this call's own promise.
    void session
      .sendManageRequest(
        buildCommand({ method: "introduce", peerId, dataPort }),
        FRAME_SCOPE,
      )
      .catch(() => undefined);
  }

  // -----------------------------------------------------------------------
  // MeshTransport -- Become coordinator (server side)
  // -----------------------------------------------------------------------

  async becomeCoordinator(host: string, port: number): Promise<void> {
    const id = nanoid(8);
    const listener = await this.wireTransport.listen(
      `${host}:${String(port)}`,
      (connection) => {
        const tracked = this.coordinatorListeners.get(id);
        void this.handleAcceptedConnection(
          connection,
          tracked?.policy,
          false,
          true,
        );
      },
    );
    this._isCoordinator = true;
    this.coordinatorListeners.set(id, {
      listener,
      policy: "full",
      host,
      port: listenerPort(listener),
      isDefault: true,
    });
    this.defaultListenerId = id;
  }

  // -----------------------------------------------------------------------
  // MeshTransport -- Peer-to-peer data connections
  // -----------------------------------------------------------------------

  async connectToPeer(peer: PeerInfo, _ownPeerId: string): Promise<void> {
    if (this.shutDown || this.dataDials.has(peer.id)) return;
    this.dataDials.add(peer.id);
    const connection = await this.wireTransport
      .connect(`${COORDINATOR_HOST}:${String(peer.port)}`)
      .catch((error: unknown) => {
        this.events.onError?.(
          error instanceof Error
            ? new Error(
                `connectToPeer(${peer.id}, port ${String(peer.port)}): ${error.message}`,
              )
            : new Error(
                `connectToPeer(${peer.id}, port ${String(peer.port)}) failed`,
              ),
        );
        return undefined;
      });
    if (connection === undefined || this.isShuttingDown()) {
      this.dataDials.delete(peer.id);
      return;
    }
    const peerDeviceId = connection.peerDeviceId;
    if (peerDeviceId === undefined) {
      this.dataDials.delete(peer.id);
      await connection.close();
      return;
    }
    const deviceIdHex = deviceIdToHex(peerDeviceId);
    if (deviceIdHex !== peer.id) {
      // The peer we reached does not hold the key peer.id claims to name -- refuse exactly like a mismatched fingerprint would have under the previous transport.
      this.events.onError?.(
        new Error(
          `connectToPeer: peer at port ${String(peer.port)} authenticated as ${deviceIdHex}, expected ${peer.id}`,
        ),
      );
      this.dataDials.delete(peer.id);
      await connection.close();
      return;
    }
    const identity = await this.identityReady;
    const session = await acceptMeshSession(connection, identity, [DOMAIN]);
    if (this.isShuttingDown()) {
      this.dataDials.delete(peer.id);
      await session.close();
      return;
    }
    this.trackSession(deviceIdHex, session);
    const handle: ConnectionHandle = { id: deviceIdHex };
    this.consumeIncoming(session, handle);
    this.watchForDisconnect(session, handle, deviceIdHex);
  }

  // -----------------------------------------------------------------------
  // MeshTransport -- Send / broadcast
  // -----------------------------------------------------------------------

  async send(handle: ConnectionHandle, message: MeshMessage): Promise<void> {
    const session = this.peerSessions.get(handle.id);
    if (session === undefined) return;
    await session
      .sendManageRequest(buildCommand(message), FRAME_SCOPE)
      .catch((error: unknown) => {
        this.events.onError?.(
          error instanceof Error
            ? error
            : new Error(`send(${handle.id}) failed: ${String(error)}`),
        );
      });
  }

  async broadcast(message: MeshMessage): Promise<void> {
    const command = buildCommand(message);
    await Promise.all(
      [...this.peerSessions.values()].map((session) =>
        session.sendManageRequest(command, FRAME_SCOPE).catch(() => undefined),
      ),
    );
  }

  async broadcastRevocation(
    entries: readonly RevocationEntry[],
  ): Promise<void> {
    await Promise.all(
      [...this.peerSessions.values()].map((session) =>
        session.sendRevocationAnnounce(entries).catch(() => undefined),
      ),
    );
  }

  async sendRoomRequest(
    memberId: string,
    command: ManageCommand,
    scope: Readonly<CapabilityScope>,
    token?: CapabilityToken,
  ): Promise<ManageOutcome> {
    const session = this.peerSessions.get(memberId);
    if (session === undefined) {
      return { result: "error", code: "not_connected" };
    }
    return session.sendManageRequest(command, scope, undefined, token);
  }

  // -----------------------------------------------------------------------
  // MeshTransport -- Connection approval (connectToRemote flow)
  // -----------------------------------------------------------------------

  async connectToRemote(
    host: string,
    port: number,
    peerId: string,
    dataPort: number,
    name: string,
    fingerprint: string,
  ): Promise<void> {
    const connection = await this.wireTransport.connect(
      `${host}:${String(port)}`,
    );
    const identity = await this.identityReady;
    const session = await acceptMeshSession(connection, identity, [DOMAIN]);
    const outcome = await session.sendManageRequest(
      buildCommand({
        method: "connect_request",
        peerId,
        dataPort,
        name,
        fingerprint,
      }),
      FRAME_SCOPE,
    );
    if (outcome.result === "error") {
      await session.close();
      throw new Error(outcome.message ?? outcome.code);
    }
    const coordinatorDeviceId = connection.peerDeviceId;
    if (coordinatorDeviceId !== undefined) {
      const handle: ConnectionHandle = {
        id: deviceIdToHex(coordinatorDeviceId),
      };
      this.trackSession(handle.id, session);
      this.consumeIncoming(session, handle);
      this.watchForDisconnect(session, handle, handle.id);
    }
  }

  async acceptConnection(handle: ConnectionHandle): Promise<void> {
    const pending = this.pendingConnections.get(handle.id);
    if (pending === undefined) {
      throw new Error(`No pending connection for handle ${handle.id}`);
    }
    this.pendingConnections.delete(handle.id);
    await pending.respond({ result: "ok" });
    // Must happen before onIntroduction fires below: mesh-store's own handleIntroduction sends a reply on this exact handle synchronously as part of handling that event, which needs peerSessions already populated -- waiting for consumeQuarantined's own suspended loop to resume (via resolve() below) would race, since that only happens on a later microtask tick.
    this.trackSession(handle.id, pending.session);
    const acceptedHandle: ConnectionHandle = {
      id: handle.id,
      ...(pending.policy !== undefined ? { policy: pending.policy } : {}),
    };
    this.events.onIntroduction(acceptedHandle, {
      peerId: handle.id,
      dataPort: pending.dataPort,
    });
    // Resumes consumeQuarantined's own still-blocked loop iteration so it starts trusting subsequent requests on this same session.
    pending.resolve("accept");
  }

  async rejectConnection(
    handle: ConnectionHandle,
    reason: string,
  ): Promise<void> {
    const pending = this.pendingConnections.get(handle.id);
    if (pending === undefined) {
      throw new Error(`No pending connection for handle ${handle.id}`);
    }
    this.pendingConnections.delete(handle.id);
    await pending.respond({
      result: "error",
      code: "rejected",
      message: reason,
    });
    // Resumes consumeQuarantined's blocked loop iteration, which closes the session itself -- it was never tracked anywhere else to close it from here.
    pending.resolve("reject");
  }

  // -----------------------------------------------------------------------
  // MeshTransport -- Listener management
  // -----------------------------------------------------------------------

  async addListener(
    host: string,
    port: number,
    policy: ListenerPolicy,
  ): Promise<string> {
    const id = nanoid(8);
    const listener = await this.wireTransport.listen(
      `${host}:${String(port)}`,
      (connection) => {
        void this.handleAcceptedConnection(connection, policy, false, true);
      },
    );
    this.coordinatorListeners.set(id, {
      listener,
      policy,
      host,
      port: listenerPort(listener),
      isDefault: false,
    });
    return id;
  }

  async removeListener(id: string): Promise<void> {
    if (id === this.defaultListenerId) {
      throw new Error("Cannot remove the default listener");
    }
    const tracked = this.coordinatorListeners.get(id);
    if (tracked === undefined) return;
    this.coordinatorListeners.delete(id);
    await tracked.listener.close();
  }

  listListeners(): ListenerInfo[] {
    return [...this.coordinatorListeners.entries()].map(([id, tracked]) => ({
      id,
      host: tracked.host,
      port: tracked.port,
      policy: tracked.policy,
      isDefault: tracked.isDefault,
    }));
  }

  // -----------------------------------------------------------------------
  // MeshTransport -- Shutdown / unref
  // -----------------------------------------------------------------------

  async shutdown(): Promise<void> {
    this.shutDown = true;
    this.dataDials.clear();

    for (const pending of this.pendingConnections.values()) {
      await pending
        .respond({ result: "error", code: "shutting_down" })
        .catch(() => undefined);
      // Unblocks consumeQuarantined's own suspended loop iteration for this session -- otherwise it never settles, even though the session itself is about to be closed below via allSessions.
      pending.resolve("reject");
    }
    this.pendingConnections.clear();

    // Every live session, whichever of possibly several to the same peer -- peerSessions alone would only close the last one registered under a shared key, leaving any other (e.g. the coordinator-client session to a peer this side also has a data connection to) still open and accepting, which would make the listener it belongs to wait forever for it to end.
    for (const session of this.allSessions) {
      await session.close().catch(() => undefined);
    }
    this.allSessions.clear();
    this.peerSessions.clear();
    this.coordinatorSession = undefined;

    if (this.dataListener !== undefined) {
      await this.dataListener.close();
      this.dataListener = undefined;
    }

    for (const tracked of this.coordinatorListeners.values()) {
      await tracked.listener.close();
    }
    this.coordinatorListeners.clear();
  }

  unref(): void {
    this.dataListener?.unref?.();
    for (const tracked of this.coordinatorListeners.values()) {
      tracked.listener.unref?.();
    }
  }
}

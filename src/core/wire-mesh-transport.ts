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
  type DirectoryEntry,
  type IncomingManageRequest,
  type ManageOutcome,
} from "wire-mesh-core/domain/mesh-session";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import {
  handleDataEntries,
  handleDataHave,
  handleDataRequest,
} from "wire-mesh-core/domain/data-sync";
import type {
  CapabilityScope,
  CapabilityToken,
  DataHaveFrame,
  DataRequestFrame,
  Frame,
  ManageCommand,
  PeerAdvert,
  RevocationEntry,
} from "wire-mesh-core/generated/protocol";
import type {
  Connection,
  Listener,
  Transport,
} from "wire-mesh-core/ports/transport";
import type { KeyValueStorage } from "wire-mesh-core/ports/storage";
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
import { AgentStatus } from "./types.js";
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

/** How long a connect_request may sit awaiting a human decision before this side gives up and rejects it automatically. Generous on purpose -- this bounds a human approval window, not a network timeout: 5 minutes covers a person genuinely being away from the terminal for a few minutes, while still guaranteeing every unanswered request eventually resolves instead of accumulating in pendingConnections indefinitely. */
const PENDING_CONNECTION_TIMEOUT_MINUTES = 5;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const DEFAULT_PENDING_CONNECTION_TIMEOUT_MS =
  PENDING_CONNECTION_TIMEOUT_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND;

/** How often this side re-sends its own presence status onto every live session's gossip self-advert. wire-mesh-core's own sendGossipUpdate deliberately owns no cadence of its own (a MeshSession only sends what it's told, when it's told) -- this is that cadence, chosen generously enough to avoid chattiness on an idle mesh while still keeping a remote peer's own picture of this agent's status fresh well within the tens-of-minutes staleness window a status change (active -\> idle -\> offline) is actually meaningful over. */
const PRESENCE_READVERTISE_INTERVAL_SECONDS = 20;
const PRESENCE_READVERTISE_INTERVAL_MS =
  PRESENCE_READVERTISE_INTERVAL_SECONDS * MS_PER_SECOND;

/** Length of the random id minted for a tracked listener (the coordinator's own bootstrap listener, or one registered via addListener). */
const LISTENER_ID_LENGTH = 8;

/** The domain-qualified gossip extension key this transport reads/writes presence under, per wire-mesh's own gossip-extension-namespacing convention (spec/CONVENTIONS.md): `<domain>/<field>`, never a bare name a second application's own extension could collide with. */
const PRESENCE_GOSSIP_KEY = "presence/status";

/** The domain-qualified gossip extension key this transport writes this side's own currently-hosted public/private rooms under -- the write half of P3.8's room-discovery replacement for createRoom's own broadcastPatch (agent-comms#48). Same namespacing convention as PRESENCE_GOSSIP_KEY. */
const HOSTED_ROOMS_GOSSIP_KEY = "room/hosted";

/** The lightweight, gossip-safe shape a room advertises itself under: enough for a peer to display "this device hosts a discoverable room here" without exposing anything membership- or grant-related. Deliberately excludes secret rooms (never worth advertising at all) and every CRDT membership field a real Room carries -- a gossip-discovered entry is a hint pointing at a room to join, not a substitute for the real Room object join/admission still produces. */
export interface HostedRoomAdvert {
  path: string;
  name: string;
  type: "public" | "private";
  description: string;
}

/** The domain-qualified gossip extension key this transport writes this side's own agent identity facts under -- the write half of P3.8's eventual agent register/update/offline retirement (agent-comms#48). Same namespacing convention as PRESENCE_GOSSIP_KEY/HOSTED_ROOMS_GOSSIP_KEY. */
const AGENT_SELF_GOSSIP_KEY = "agent/self";

/** The lightweight, gossip-safe shape an agent advertises itself under: enough for a peer with no prior local record of this device to construct a real AgentIdentity-shaped discovery entry. Deliberately excludes status (already carried separately under presence/status, no need to duplicate it here) and visibility (this field is only ever populated for a "visible" agent in the first place -- see MeshStore's own selfAgentAdvert getter -- so a discovered entry's visibility is always exactly "visible" by construction, never something this advert needs to assert itself). */
export interface AgentSelfAdvert {
  name: string;
  harness: string;
  cwd: string;
  pid: number;
  startedAt: string;
  tags: string[];
  subscribedRooms: string[];
}

/** Upper bound on the number of oplog entries handleDataRequest returns in a single data-entries response -- generous for the small, chat-sized messages this domain carries today, while still bounding one peer's worst-case memory/frame size when answering a request for a large catch-up gap. A requester short of this still gets everything up to its own current head; anything beyond it needs a follow-up data-request, exactly the same incremental-catch-up shape a data-have/data-request/data-entries cycle already has. */
const DATA_ENTRIES_RESPONSE_LIMIT = 100;

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
  /** Auto-rejects this request after the configured pending-connection timeout if no human decision arrives first. Cleared by acceptConnection/rejectConnection/watchForDisconnect's own disconnect path, whichever settles the request first -- an entry is only ever removed from pendingConnections once, so this timer firing after another path already resolved it is structurally impossible, not merely guarded against. */
  timeoutHandle: ReturnType<typeof setTimeout>;
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
  private readonly coordinatorListeners = new Map<string, TrackedListener>();
  private defaultListenerId: string | undefined;

  // -- The session dialled via connectToCoordinator, when this instance is not itself the coordinator --
  private coordinatorSession: AcceptedMeshSession | undefined;

  // -- Every live session, keyed by the peer's authenticated device-id hex (== ConnectionHandle.id) -- covers coordinator-client, coordinator-accepted, and peer data sessions alike, since send()/broadcast() must reach whichever kind of session a peer happens to be reachable through. A single-slot-per-key map by construction: mesh formation genuinely establishes TWO independent sessions to the same peer (see the dataDials comment below), and the second one registered here simply overwrites the first as far as addressing goes -- fine for send()/broadcast() (either socket reaches the same peer), but NOT fine for shutdown, which must close every live session regardless of whether it's still reachable through this map. allSessions below exists specifically so shutdown never leaks the one this map's overwrite silently stopped tracking.
  private readonly peerSessions = new Map<string, AcceptedMeshSession>();

  // -- Every live session this transport has ever created, accepted or dialled, for shutdown's own use only -- never used for addressing (peerSessions is), so it never loses track of one session to another sharing the same peer id.
  private readonly allSessions = new Set<AcceptedMeshSession>();

  // -- Every device-id this side has ever heard gossip from, across every session's own directory, keyed by device-id hex -- the mesh-wide aggregation P3.8's own room-discovery design and the eventual agent register/update/offline retirement both need and don't otherwise have (agent-comms#48's own 2026-09-14 investigation confirmed no such aggregation existed anywhere in this file). Merged, never cleared on disconnect: a device's last-known advert (including its own presence/status, or any future gossiped extension) stays queryable even while its session is momentarily down, the same way the legacy agents Map keeps a record after setAgentOffline rather than deleting it outright.
  private readonly knownDevices = new Map<string, PeerAdvert>();

  /** Merges one session event's own directory into the mesh-wide knownDevices view, keeping the newer advert (by snapshot-seconds) whenever this device-id is already known from an earlier event or a different session. */
  private mergeKnownDevices(directory: readonly DirectoryEntry[]): void {
    for (const entry of directory) {
      const deviceIdHex = deviceIdToHex(entry.device);
      const existing = this.knownDevices.get(deviceIdHex);
      if (
        existing === undefined ||
        entry.advert["snapshot-seconds"] >= existing["snapshot-seconds"]
      ) {
        this.knownDevices.set(deviceIdHex, entry.advert);
      }
    }
  }

  /** Every device this side has ever heard gossip from, mesh-wide -- not just its own directly-connected peers -- with each one's own latest full advert (addresses, snapshot-seconds, and every open-extension field such as presence/status). */
  listKnownDevices(): readonly {
    deviceId: string;
    advert: Readonly<PeerAdvert>;
  }[] {
    return Array.from(this.knownDevices, ([deviceId, advert]) => ({
      deviceId,
      advert,
    }));
  }

  /** Registers a session in both peerSessions (addressing -- last one in for a given peer wins) and allSessions (shutdown -- every session, always). */
  private trackSession(key: string, session: AcceptedMeshSession): void {
    this.peerSessions.set(key, session);
    this.allSessions.add(session);
  }

  // -- Peers this side has dialled via connectToPeer specifically (in flight or established) -- deliberately separate from peerSessions, which also holds sessions this side reached the SAME peer through for an unrelated reason (most concretely, the coordinator-client session connectToCoordinator opens to the coordinator's own device-id). Mesh formation deliberately establishes a second, independent connection in each direction so each side's own acceptor can push its own state (see mesh-store.ts's own handlePeerConnected), so connectToPeer's "don't dial twice" guard must not be satisfied by an unrelated session that merely happens to share the same peer ID.
  private readonly dataDials = new Set<string>();

  // -- connect_request frames awaiting a human accept/reject decision, keyed by the requester's device-id hex --
  private readonly pendingConnections = new Map<string, PendingConnection>();

  // -- The single consumer of every approved session's incomingManageRequests, once quarantine (if any) is past. Owns verb dispatch (the legacy opaque frame, plus whichever real core/room verbs later phases register handlers for) -- this transport itself no longer decodes or routes a MeshMessage at all beyond handing a session off here.
  private readonly roomRouter: RoomRouter;

  private readonly pendingConnectionTimeoutMs: number;

  /** Reads this side's own current AgentStatus for the next gossip re-advertisement tick -- a pull, not a push, so MeshStore never needs to reach into this transport's internals on every status change (see updateAgent/setAgentOffline, which patch MeshStore's own agents map and let the next tick pick it up). undefined when no presence source was wired in (every existing construction site that predates this feature). */
  private readonly getCurrentPresence:
    (() => AgentStatus | undefined) | undefined;
  /** Reads this side's own currently-hosted public/private rooms for the next gossip re-advertisement tick, the same pull-not-push shape getCurrentPresence already established -- createRoom/destroyRoom patch MeshStore's own rooms map and let the next tick pick it up, rather than pushing an update here on every mutation. undefined when no hosted-rooms source was wired in. */
  private readonly getHostedRooms:
    (() => readonly HostedRoomAdvert[]) | undefined;
  private gossipInterval: ReturnType<typeof setInterval> | undefined;

  /** Backs this side's own responder for an incoming data-have/data-request/data-entries frame (agent-comms#50's P5 integration) -- undefined for every existing construction site that predates this feature, in which case handleDataFrame is a no-op. Deciding when to proactively call sendDataFrame at all (the catch-up policy: which peers' logs to track, when to send an initial data-have) stays entirely the caller's own business; this field only ever backs the mechanical parts (answering a have/request, storing entries). */
  private readonly dataStorage: KeyValueStorage | undefined;

  /** Reads this side's own gossip-safe agent-identity advert for the next gossip re-advertisement tick, the same pull-not-push shape getCurrentPresence/getHostedRooms already established. undefined when no agent-identity source was wired in, or when MeshStore's own getter decides this agent shouldn't advertise itself this way right now (e.g. not "visible", or no self-agent record yet). */
  private readonly getSelfAgentAdvert:
    (() => AgentSelfAdvert | undefined) | undefined;

  /** Every peer this side has ever received a frame from, keyed by device-id hex, tracking the raw wire-mesh-core Connection each frame arrived on -- what sendDataFrame needs, since neither AcceptedMeshSession nor MeshSession exposes a generic "send an arbitrary frame" method the way the raw Connection itself does. Registered eagerly on the very first frame from a connection (including one still in quarantine, e.g. before connect_request approval) so a later sendDataFrame call can reach it -- handleDataFrame's own trust gate (peerSessions.has) is what actually decides whether to act on anything received this way, not this map. */
  private readonly connectionsByPeer = new Map<string, Connection>();

  constructor(
    events: Readonly<TransportEvents>,
    identity: Readonly<PeerIdentity>,
    roomVerbHandlers?: Partial<Record<string, RoomVerbHandler>>,
    pendingConnectionTimeoutMs: number = DEFAULT_PENDING_CONNECTION_TIMEOUT_MS,
    getCurrentPresence?: () => AgentStatus | undefined,
    presenceReadvertiseIntervalMs: number = PRESENCE_READVERTISE_INTERVAL_MS,
    getHostedRooms?: () => readonly HostedRoomAdvert[],
    dataStorage?: KeyValueStorage,
    getSelfAgentAdvert?: () => AgentSelfAdvert | undefined,
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
    this.pendingConnectionTimeoutMs = pendingConnectionTimeoutMs;
    this.getCurrentPresence = getCurrentPresence;
    this.getHostedRooms = getHostedRooms;
    this.dataStorage = dataStorage;
    this.getSelfAgentAdvert = getSelfAgentAdvert;
    if (
      getCurrentPresence !== undefined ||
      getHostedRooms !== undefined ||
      getSelfAgentAdvert !== undefined
    ) {
      this.gossipInterval = setInterval(() => {
        this.readvertiseGossip();
      }, presenceReadvertiseIntervalMs);
      this.gossipInterval.unref();
    }
  }

  /** Sends one data-have or data-request frame directly to an already-connected peer -- the mechanical send primitive a future catch-up policy calls once it decides to (see the dataStorage field comment). Throws if this side has never received any frame from that peer yet (there is no connection to send on), matching sendManageRequest's own "no reachable session" failure mode for an unknown peer. */
  async sendDataFrame(
    peerDeviceHex: string,
    frame: Readonly<DataHaveFrame> | Readonly<DataRequestFrame>,
  ): Promise<void> {
    const connection = this.connectionsByPeer.get(peerDeviceHex);
    if (connection === undefined) {
      throw new Error(
        `WireMeshTransport: no live connection for peer ${peerDeviceHex}`,
      );
    }
    await connection.send(frame);
  }

  /** Registers (or refreshes) the raw connection a frame arrived on, then answers a data-have/data-request/data-entries frame in place, sending any resulting response frame back over the same connection -- every other frame type is ignored here (applyFrame's own dispatch already owns those). Trust-gated on peerSessions already tracking this device: a connection still in quarantine (pre-approval) gets its own frames observed here too (registration is unconditional, since a later approved sendDataFrame call still needs to find it), but never acted on until trackSession has actually run for it. A response or storage failure is reported via onError and otherwise dropped -- the peer's own next data-have/retry is what recovers, the same as any other best-effort gossip-driven exchange in this file. */
  private async handleDataFrame(
    connection: Readonly<Connection>,
    frame: Frame,
  ): Promise<void> {
    const peerDeviceId = connection.peerDeviceId;
    if (peerDeviceId === undefined) return;
    const deviceIdHex = deviceIdToHex(peerDeviceId);
    this.connectionsByPeer.set(deviceIdHex, connection);
    if (this.dataStorage === undefined) return;
    if (!this.peerSessions.has(deviceIdHex)) return;
    try {
      if (frame.type === "data-have") {
        const request = await handleDataHave(this.dataStorage, frame);
        if (request !== null) await connection.send(request);
      } else if (frame.type === "data-request") {
        const entries = await handleDataRequest(
          this.dataStorage,
          frame,
          DATA_ENTRIES_RESPONSE_LIMIT,
        );
        if (entries !== null) await connection.send(entries);
      } else if (frame.type === "data-entries") {
        await handleDataEntries(this.dataStorage, frame);
      }
    } catch (error: unknown) {
      this.events.onError?.(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  /** Re-sends this side's own current presence status and currently-hosted rooms, together, onto every live session's gossip self-advert -- one gossip frame per tick carrying whichever of the two sources is wired in, rather than a separate frame per fact. A session that fails to send (mid-disconnect, most likely -- watchForDisconnect will independently notice and clean it up) is reported via onError and skipped, not allowed to stop the tick from reaching the rest of allSessions: a periodic broadcast to N peers is N independent operations, not one atomic unit. A no-op tick (neither source wired in, or no sessions exist yet) is expected and silent. */
  private readvertiseGossip(): void {
    const extensions: Record<string, unknown> = {};
    const status = this.getCurrentPresence?.();
    if (status !== undefined) extensions[PRESENCE_GOSSIP_KEY] = status;
    const hostedRooms = this.getHostedRooms?.();
    if (hostedRooms !== undefined)
      extensions[HOSTED_ROOMS_GOSSIP_KEY] = hostedRooms;
    const selfAgentAdvert = this.getSelfAgentAdvert?.();
    if (selfAgentAdvert !== undefined)
      extensions[AGENT_SELF_GOSSIP_KEY] = selfAgentAdvert;
    if (Object.keys(extensions).length === 0) return;
    for (const session of this.allSessions) {
      session.sendGossipUpdate(extensions).catch((error: unknown) => {
        this.events.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
    }
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
    const session = await acceptMeshSession(connection, identity, [DOMAIN], {
      onFrame: async (conn, frame) => this.handleDataFrame(conn, frame),
    });
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
    handle: Readonly<ConnectionHandle>,
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
          // Held open deliberately -- see this file's own header comment. Answered later by acceptConnection/rejectConnection, or by this.expirePendingConnection if neither happens within pendingConnectionTimeoutMs.
          const decision = await new Promise<ConnectionDecision>((resolve) => {
            this.pendingConnections.set(handle.id, {
              respond: request.respond,
              dataPort: message.dataPort,
              name: message.name,
              fingerprint: message.fingerprint,
              policy: handle.policy,
              session,
              resolve,
              // unref()'d so a stray pending connection (this timer failing to be cleared through some path not yet covered) can never by itself keep the process alive for up to pendingConnectionTimeoutMs after everything else is done -- confirmed necessary directly: shutdown() originally cleared every pendingConnections entry without clearing its timer, and the whole test process hung for the full default timeout before exiting.
              timeoutHandle: setTimeout(() => {
                this.expirePendingConnection(handle.id);
              }, this.pendingConnectionTimeoutMs).unref(),
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
    handle: Readonly<ConnectionHandle>,
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

  /** Surfaces a presence extension from the remote peer's own gossiped self-advert, if this event's directory carries a fresh one for exactly this session's peer -- never for any other device-id a multi-hop directory might mention, since only the session's own authenticated peer's advert is this session's business to report. A missing presence/status key, or a value that isn't a recognised AgentStatus, is silently ignored: an advert simply not participating in this convention, not an error (the same verifier obligation peer-advert's own open extension tail is documented under). */
  private reportPresenceAdvert(
    handle: Readonly<ConnectionHandle>,
    deviceIdHex: string,
    directory: readonly DirectoryEntry[],
  ): void {
    const entry = directory.find(
      (candidate) => deviceIdToHex(candidate.device) === deviceIdHex,
    );
    if (entry === undefined) return;
    const status: unknown = entry.advert[PRESENCE_GOSSIP_KEY];
    if (!AgentStatus.is(status)) return;
    this.events.onPresenceAdvert(handle, status);
  }

  private watchForDisconnect(
    session: AcceptedMeshSession,
    handle: Readonly<ConnectionHandle>,
    deviceIdHex: string,
  ): void {
    void (async () => {
      for await (const event of session.events) {
        this.mergeKnownDevices(event.directory);
        this.reportPresenceAdvert(handle, deviceIdHex, event.directory);
        if (event.state.status === "closed") {
          const wasTracked = this.peerSessions.get(deviceIdHex) === session;
          if (wasTracked) this.peerSessions.delete(deviceIdHex);
          this.allSessions.delete(session);
          // A requester disconnecting before a human decides must unblock consumeQuarantined's own still-suspended loop iteration -- otherwise that promise, and the closure awaiting it, never settle.
          const pending = this.pendingConnections.get(deviceIdHex);
          if (pending !== undefined) {
            clearTimeout(pending.timeoutHandle);
            pending.resolve("reject");
            this.pendingConnections.delete(deviceIdHex);
          }
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

  /** Auto-rejects a connect_request that has sat unanswered past pendingConnectionTimeoutMs -- the same respond-then-resolve shape rejectConnection uses (a real error response, not a silent hang), since unlike watchForDisconnect's own cleanup path the requester's session is still very much alive and waiting to hear back. A no-op if the request was already settled by acceptConnection/rejectConnection/disconnect before this timer fired -- entries are deleted exactly once, by whichever path settles first. */
  private expirePendingConnection(id: string): void {
    const pending = this.pendingConnections.get(id);
    if (pending === undefined) {
      return;
    }
    this.pendingConnections.delete(id);
    void pending
      .respond({
        result: "error",
        code: "timeout",
        message: "no human decision within the pending-connection timeout",
      })
      .catch(() => undefined);
    pending.resolve("reject");
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
    const session = await acceptMeshSession(connection, identity, [DOMAIN], {
      onFrame: async (conn, frame) => this.handleDataFrame(conn, frame),
    });
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
    const id = nanoid(LISTENER_ID_LENGTH);
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

  async connectToPeer(
    peer: Readonly<PeerInfo>,
    _ownPeerId: string,
  ): Promise<void> {
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
    const session = await acceptMeshSession(connection, identity, [DOMAIN], {
      onFrame: async (conn, frame) => this.handleDataFrame(conn, frame),
    });
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

  async send(
    handle: Readonly<ConnectionHandle>,
    message: MeshMessage,
  ): Promise<void> {
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
      [...this.peerSessions.values()].map(async (session) =>
        session.sendManageRequest(command, FRAME_SCOPE).catch(() => undefined),
      ),
    );
  }

  async broadcastRevocation(
    entries: readonly RevocationEntry[],
  ): Promise<void> {
    await Promise.all(
      [...this.peerSessions.values()].map(async (session) =>
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
    const session = await acceptMeshSession(connection, identity, [DOMAIN], {
      onFrame: async (conn, frame) => this.handleDataFrame(conn, frame),
    });
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

  async acceptConnection(handle: Readonly<ConnectionHandle>): Promise<void> {
    const pending = this.pendingConnections.get(handle.id);
    if (pending === undefined) {
      throw new Error(`No pending connection for handle ${handle.id}`);
    }
    clearTimeout(pending.timeoutHandle);
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
    handle: Readonly<ConnectionHandle>,
    reason: string,
  ): Promise<void> {
    const pending = this.pendingConnections.get(handle.id);
    if (pending === undefined) {
      throw new Error(`No pending connection for handle ${handle.id}`);
    }
    clearTimeout(pending.timeoutHandle);
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
    const id = nanoid(LISTENER_ID_LENGTH);
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
    if (this.gossipInterval !== undefined) {
      clearInterval(this.gossipInterval);
      this.gossipInterval = undefined;
    }
    this.dataDials.clear();

    for (const pending of this.pendingConnections.values()) {
      clearTimeout(pending.timeoutHandle);
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

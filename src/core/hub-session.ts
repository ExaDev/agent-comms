/**
 * HubSession -- the relay-hub connection mode (agent-comms#151), split from wire-mesh-transport.ts under the max-lines cap the same way connection-approval.ts and its siblings were. A hub connection (wss://mesh.exadev.io/) is a RELAY, not a coordinator: no connect_request/introduce approval applies. The session's own self-advert is forwarded by the hub to every other connected agent and the hub answers with a catch-up of everyone already there, so peers discover each other purely through gossip. Messages ride relay-connect pairings -- sendManageRequest's own targetDevice routing, which the session layer wraps as relay-data to exactly that device.
 */

import {
  acceptMeshSession,
  type AcceptedMeshSession,
  type DirectoryEntry,
  type IncomingManageRequest,
  type ManageOutcome,
} from "wire-mesh-core/domain/mesh-session";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { tracePath as coreTracePath } from "wire-mesh-core/domain/path-trace";
import type {
  CapabilityScope,
  CapabilityToken,
  Frame,
  ManageCommand,
} from "wire-mesh-core/generated/protocol";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import type { Connection } from "wire-mesh-core/ports/transport";
import type {
  ConnectionHandle,
  MeshTraceResult,
  TransportEvents,
} from "./transport.js";
import type { MeshMessage } from "./wire-protocol.js";
import { extractMessage } from "./room-router.js";
import { connectWsUrl } from "./ws-dial.js";
import {
  buildCommand,
  DOMAIN,
  FRAME_SCOPE,
  FRAME_VERB,
} from "./wire-mesh-transport.js";

/** How long a room-domain request routed through the hub's relay-connect/relay-data pairing waits for a response before giving up. Unlike an ordinary local peer session, a relay-connect naming an unknown target-device is silently dropped by the hub (spec/relay-hub's own documented behaviour -- no error frame exists for "no such device"), so a request to a device that turns out not to be reachable via any gateway would otherwise hang forever rather than surfacing as a normal "not reachable" outcome. */
const HUB_ROOM_REQUEST_TIMEOUT_MS = 15_000;

export interface HubSessionDeps {
  /** Resolves this node's own identity port once ready. */
  identityReady: Promise<Readonly<IdentityPort>>;
  events: Readonly<TransportEvents>;
  /** The transport's own shutdown gate -- checked around every await, the same discipline the transport itself applies. */
  isShuttingDown: () => boolean;
  /** The addresses this node advertises in its own gossip self-advert. */
  advertisedAddresses: readonly string[];
  /** Registers a frame observer + dispatch for raw frames arriving on the hub connection (the transport's own handleDataFrame path). */
  onFrame: (
    connection: Readonly<Connection>,
    frame: Readonly<Frame>,
  ) => void | Promise<void>;
  /** Tracks the session for shutdown -- every session the transport ever creates, always. */
  trackForShutdown: (session: AcceptedMeshSession) => void;
  /** Fires with every remote (non-self) directory entry the hub's own gossip/catch-up surfaces, every time the session's directory changes (agent-comms#155's own remote-directory-merge leg) -- the transport merges these into its own mesh-wide knownDevices the same way it already merges a local peer session's directory, so a hub-learned agent surfaces in listAgents/getAgent with no separate lookup path. */
  onDirectory: (entries: readonly DirectoryEntry[]) => void;
  /** Dispatches an already-received, non-legacy-frame request (a real core/room verb: room.send, room.notify, room.join, ...) to WireMeshTransport's own roomRouter, the identical dispatch a local peer session's own drainSession already uses -- the outbound half of agent-comms#155's "remote to local" routing leg. Deferred the same lazy-`this`-capture way DeliveryEngine's own sendRoomRequestToMember closure is, since roomRouter is constructed after this class's own instance in WireMeshTransport's constructor. */
  handleRoomRequest: (
    request: IncomingManageRequest,
    handle: Readonly<ConnectionHandle>,
  ) => Promise<void>;
  /** The gateway trust boundary (agent-comms#156): whether the given device-id (hex) is currently trusted as a bare device. Since agent-comms#192, this gates only the traffic that carries no independent per-message security of its own: the legacy FRAME_VERB path (consume()'s own doc explains why) and dispatchHubRequest's own hubPeersKnown bookkeeping for a room-domain sender. A real room-domain verb's own dispatch is never gated on this at all; see dispatchHubRequest's own doc for why that is sound. connect()'s own directory-merge filter uses isTrustedForDirectory below instead, not this. */
  isTrusted: (deviceHex: string) => boolean;
  /** Whether the given device-id (hex) is trusted for gossip directory-merge purposes (agent-comms#192): true when it is on the same bare-device allowlist isTrusted above checks, or when it is itself a trusted user-principal's own device-id (agent-comms#187's GatewayTrust.isTrustedPrincipal). A gossiped directory entry carries no capability token to chain-verify, only a bare device-id, so this can't reuse isTrustedFor's own bearer/rootIssuer chain check the way a real capability-token verification does; checking the gossiped device-id directly against the principal set is the sound degenerate case of that check, since a principal's own device presenting itself is, trivially, its own chain root. Scoped to connect()'s own directory-merge filter only: every other isTrusted call site keeps its original bare-device-only meaning, since agent-comms#192 only asked for the principal extension here. */
  isTrustedForDirectory: (deviceHex: string) => boolean;
  /** Forwards a room-domain manage-request on to a specific LOCAL peer session (one this gateway is directly connected to over the ordinary local mesh, keyed by device-id hex) rather than dispatching it against this gateway's own local state -- consume()'s own toDevice disambiguation (agent-comms#184, wire-mesh-core 1.48.1's IncomingManageRequest.toDevice). Returns undefined when no local session exists for that device-id, in which case consume() falls back to handleRoomRequest exactly as it always has. */
  forwardToLocalPeer: (
    deviceHex: string,
    command: ManageCommand,
    scope: Readonly<CapabilityScope>,
    token?: CapabilityToken,
  ) => Promise<ManageOutcome> | undefined;
}

export class HubSession {
  private session: AcceptedMeshSession | undefined;
  /** The raw connection underlying `session` -- MeshSession's own sendGossipUpdate only ever advertises this side's own single device, so advertising OTHER (local mesh) devices onto the hub (agent-comms#155's outbound leg) needs a raw gossip frame sent directly, bypassing that per-session single-self-advert limit. */
  private connection: Connection | undefined;
  /** The URL this side itself dialled to reach the hub -- tracePath's own local.hubAddress (agent-comms#199), the equivalent of wire-mesh-core's own TracePathOptions.localHubAddress. */
  private url: string | undefined;
  private readonly hubPeersKnown = new Set<string>();

  constructor(private readonly deps: Readonly<HubSessionDeps>) {}

  /** This node's own device-id, hex-encoded -- the identifier hub peers address it by. */
  async ownDeviceHex(): Promise<string> {
    const identity = await this.deps.identityReady;
    return deviceIdToHex(identity.deviceId);
  }

  /** Whether a hub session is currently live (connect() has resolved and disconnect() hasn't run since, and the far end hasn't closed it -- watchDisconnect clears this.session when the hub's own event stream reports closed). */
  get isConnected(): boolean {
    return this.session !== undefined;
  }

  /** Whether the given session object is this side's own currently-held hub session -- lets WireMeshTransport distinguish the hub's session from an ordinary local-peer session within its own allSessions bookkeeping (agent-comms#156's own readvertiseGossip gate needs this) without this class ever exposing the raw session object itself. */
  ownsSession(session: AcceptedMeshSession): boolean {
    return this.session === session;
  }

  /** Drops the held hub connection. A no-op if none is live (connect() was never called, disconnect() already ran, or the hub itself already closed the session). */
  async disconnect(): Promise<void> {
    const session = this.session;
    if (session === undefined) return;
    this.session = undefined;
    this.connection = undefined;
    this.url = undefined;
    await session.close();
  }

  /** The device ids (hex) of peers discovered through the hub's gossiped directory. */
  peers(): readonly string[] {
    return [...this.hubPeersKnown];
  }

  /** Dials the hub and participates as a peer (see the class doc for the discovery and routing model). */
  async connect(url: string): Promise<void> {
    const connection = await connectWsUrl(url);
    if (this.deps.isShuttingDown()) {
      await connection.close();
      return;
    }
    const identity = await this.deps.identityReady;
    const session = await acceptMeshSession(connection, identity, [DOMAIN], {
      onFrame: async (conn, frame) => this.deps.onFrame(conn, frame),
      addresses: [...this.deps.advertisedAddresses],
    });
    if (this.deps.isShuttingDown()) {
      await session.close();
      return;
    }
    this.session = session;
    this.connection = connection;
    this.url = url;
    this.deps.trackForShutdown(session);
    // Merge the hub's directory (its catch-up arrives as the first session events) and keep refreshing it on every subsequent one. Every trusted remote entry is also surfaced via onDirectory, so the transport can merge it into its own mesh-wide knownDevices (agent-comms#155's remote-directory-merge leg). Filtered to isTrustedForDirectory (agent-comms#156, widened by agent-comms#187's principal allowlist per agent-comms#192) before either hubPeersKnown tracking or onDirectory sees it: an untrusted device's gossiped presence is not merely withheld from listAgents, it is never even recorded as "known" here, so nothing downstream can act on it via any path this class exposes.
    void (async () => {
      const ownHex = deviceIdToHex(identity.deviceId);
      for await (const event of session.events) {
        if (this.deps.isShuttingDown()) break;
        const remoteEntries = event.directory.filter(
          (entry) =>
            deviceIdToHex(entry.device) !== ownHex &&
            this.deps.isTrustedForDirectory(deviceIdToHex(entry.device)),
        );
        for (const entry of remoteEntries) {
          this.hubPeersKnown.add(deviceIdToHex(entry.device));
        }
        if (remoteEntries.length > 0) this.deps.onDirectory(remoteEntries);
        if (event.state.status === "closed") break;
      }
    })();
    this.consume(session, deviceIdToHex(identity.deviceId));
    void (async () => {
      await this.watchDisconnect(session);
    })();
  }

  /** Consumes one hub session's inbound relayed manage-requests until it ends, dispatching each in arrival order to dispatchHubRequest -- see that function's own doc for the actual per-request trust decision. Split out purely so the decision itself is directly unit-testable against fake requests/deps (hub-session-dispatch.test.ts), the same reason hub-forwarding.ts's own forwardAdvertsToHub/pushHubCatchUp are standalone functions rather than private methods. */
  private consume(session: AcceptedMeshSession, ownDeviceHex: string): void {
    void (async () => {
      for await (const request of session.incomingManageRequests) {
        if (this.deps.isShuttingDown()) break;
        await dispatchHubRequest(request, ownDeviceHex, this.deps, (hex) => {
          this.hubPeersKnown.add(hex);
        });
      }
    })();
  }

  private async watchDisconnect(session: AcceptedMeshSession): Promise<void> {
    for await (const event of session.events) {
      if (event.state.status === "closed") break;
    }
    if (this.session === session) {
      this.session = undefined;
      this.connection = undefined;
      this.url = undefined;
    }
  }

  /** Sends one message to a hub-discovered peer through the hub's relay pairing. */
  async sendToPeer(peerDeviceHex: string, message: MeshMessage): Promise<void> {
    const session = this.session;
    if (session === undefined) {
      throw new Error("not connected to a hub");
    }
    await session.sendManageRequest(
      buildCommand(message),
      FRAME_SCOPE,
      hexToBytes(peerDeviceHex),
    );
  }

  /** Gossips a raw `gossip` frame carrying every given entry's own advert onto the hub, over the raw connection rather than sendGossipUpdate (which can only ever advertise this side's own single device) -- the outbound leg of agent-comms#155's gateway forwarding. relay-hub.ts registers each advert's own `device` field against the CONNECTION it arrives on, so every entry passed here becomes reachable, cross-machine, as "via this gateway" -- callers are responsible for only ever passing entries that are actually meant to be advertised (WireMeshTransport filters to local, visible-agent-bearing entries before calling this). Throws if this side isn't currently connected to a hub, matching sendToPeer's own contract -- callers gate on isConnected first. */
  async advertiseDevices(entries: readonly DirectoryEntry[]): Promise<void> {
    const connection = this.connection;
    if (connection === undefined) {
      throw new Error("not connected to a hub");
    }
    await connection.send({
      type: "gossip",
      peers: entries.map((entry) => entry.advert),
    });
  }

  /** Sends a real core/room manage-request to a specific hub-reachable peer, through the hub's relay-connect/relay-data pairing -- the local-to-remote leg of agent-comms#155's routing, mirroring MeshTransport.sendRoomRequest's own not_connected/outcome contract so WireMeshTransport can fall back to this uniformly when memberId isn't a local peer session. Bounded by HUB_ROOM_REQUEST_TIMEOUT_MS (see its own doc) since an unreachable target-device is silently dropped by the hub with no error frame, unlike a local session's own connection-level failure. */
  async sendRoomRequest(
    peerDeviceHex: string,
    command: ManageCommand,
    scope: Readonly<CapabilityScope>,
    token?: CapabilityToken,
  ): Promise<ManageOutcome> {
    const session = this.session;
    if (session === undefined) {
      return { result: "error", code: "not_connected" };
    }
    return session.sendManageRequest(
      command,
      scope,
      hexToBytes(peerDeviceHex),
      token,
      HUB_ROOM_REQUEST_TIMEOUT_MS,
    );
  }

  /** Sends path.trace to a specific hub-reachable peer, through the hub's relay-connect/relay-data pairing -- WireMeshTransport.meshTrace's own hub-relayed fallback (agent-comms#199), mirroring sendRoomRequest's own not_connected contract and HUB_ROOM_REQUEST_TIMEOUT_MS default for the identical reason (an unreachable target-device is silently dropped by the hub, not answered with an error). Delegates the actual send/RTT-measurement/response-parsing to wire-mesh-core's own tracePath, reporting this.url (the address this side itself dialled to reach the hub) as local.hubAddress. */
  async tracePath(
    peerDeviceHex: string,
    timeoutMs?: number,
  ): Promise<MeshTraceResult> {
    const session = this.session;
    if (session === undefined) {
      return {
        rttMs: 0,
        local: { relayed: true },
        outcome: { result: "error", code: "not_connected" },
      };
    }
    return coreTracePath({
      session,
      clock: { now: () => Date.now() },
      targetDevice: hexToBytes(peerDeviceHex),
      timeoutMs: timeoutMs ?? HUB_ROOM_REQUEST_TIMEOUT_MS,
      ...(this.url !== undefined ? { localHubAddress: this.url } : {}),
    });
  }
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** The slice of HubSessionDeps dispatchHubRequest actually needs. Named so its own tests, and consume()'s call site, don't repeat the same Pick inline. */
export type HubRequestDispatchDeps = Pick<
  HubSessionDeps,
  "isTrusted" | "events" | "handleRoomRequest" | "forwardToLocalPeer"
>;

/**
 * Decides what to do with one inbound relayed manage-request, keeping every downstream consumer's handle keyed by the SENDING device (request.fromDevice names it on relay-routed requests) rather than by this gateway, exactly as it already did for the legacy opaque-frame path and now also for a real room-domain verb (agent-comms#155's "remote to local" leg).
 *
 * A request with no fromDevice at all is refused before either path below ever sees it. Neither has anything sound to check against a value that isn't a real device-id: a legacy FRAME_VERB request has no security beyond the sender's own identity, and a room-domain verb's own downstream handler (room-router.ts's resolveHandle, then a capability-token check such as verifyRoomToken) calls deviceIdFromHex on whatever handle.id it's given, which throws on anything that isn't valid hex rather than answering with an ordinary unauthorized outcome. Answering unauthorized here, before that, is what keeps this a clean, fast failure for the request's own caller instead of an unhandled rejection that would kill this session's whole drain loop.
 *
 * The legacy FRAME_VERB path (P2's opaque-payload carriage, still the only path for anything core/room doesn't yet have real semantics for) carries no security of its own beyond the identity of its sender, so it stays gated by the coarse per-device gateway allowlist (isTrusted, agent-comms#156): an untrusted sender's frame is silently dropped, matching isStateMutatingMessage's own swallow-and-ack style so it learns nothing about why. Even a trusted sender's state_sync/state_update is still filtered out before ever reaching onMessage; see isStateMutatingMessage's own doc for why (agent-comms#169's security finding).
 *
 * A real room-domain verb (room.send, room.join, room.notify, ...) is never gated on isTrusted at all (agent-comms#192): it is independently gated by its own room:member capability token, verified regardless of which transport path it arrived over, and already principal-aware since agent-comms#187 (device-membership-verification.ts's own chain-walk). Stacking the coarse bare-device allowlist in front of that check would be redundant, not protective, and for room.join specifically (the one deliberately ungated verb, whose own security model is a human decision) it would actively defeat the protocol's own intended design by never letting an untrusted device reach that approval step at all. onKnownPeer is still only called here for a sender isTrusted already recognises: reaching this branch has not yet had its own token verified (that happens inside handleRoomRequest/forwardToLocalPeer), so hubPeersKnown stays "gateway-trusted hub peers", never "every device that has sent a syntactically valid room-domain request".
 *
 * Multi-device gateway routing (agent-comms#184, wire-mesh-core 1.48.1's own IncomingManageRequest.toDevice, read directly from each relay-data frame's own to-device field rather than guessed from pairing state): when the request carries a toDevice naming a different device than ownDeviceHex, the command is first re-stamped with an on-behalf-of params field naming the true sender before forwardToLocalPeer forwards it on to that device's own local mesh session (one this gateway is directly connected to, never merely gossiped-about); room-router.ts's own resolveHandle reads that field back out on the receiving end, so the forwarded request is attributed to the true remote sender there, never to this gateway. Its outcome is relayed straight back. Only when forwardToLocalPeer finds no such local session (toDevice is absent, matches ownDeviceHex, or names a device this gateway doesn't actually front) does the request fall through to handleRoomRequest, dispatched against this side's own local mesh state, the same fallback a sender still on a pre-#184 wire-mesh-core (never stamping toDevice at all) already relied on.
 */
export async function dispatchHubRequest(
  request: IncomingManageRequest,
  ownDeviceHex: string,
  deps: Readonly<HubRequestDispatchDeps>,
  onKnownPeer: (deviceHex: string) => void,
): Promise<void> {
  if (request.fromDevice === undefined) {
    if (request.command.verb === FRAME_VERB) {
      await request.respond({ result: "ok" }).catch(() => undefined);
    } else {
      await request
        .respond({ result: "error", code: "unauthorized" })
        .catch(() => undefined);
    }
    return;
  }

  const senderHex = deviceIdToHex(request.fromDevice);
  const handle: Readonly<ConnectionHandle> = { id: senderHex };

  if (request.command.verb === FRAME_VERB) {
    if (!deps.isTrusted(senderHex)) {
      await request.respond({ result: "ok" }).catch(() => undefined);
      return;
    }
    onKnownPeer(senderHex);
    const message = extractMessage(request.command);
    if (message !== undefined && !isStateMutatingMessage(message)) {
      deps.events.onMessage(handle, message);
    }
    await request.respond({ result: "ok" }).catch(() => undefined);
    return;
  }

  if (deps.isTrusted(senderHex)) onKnownPeer(senderHex);

  const toDeviceHex =
    request.toDevice !== undefined
      ? deviceIdToHex(request.toDevice)
      : undefined;
  if (toDeviceHex !== undefined && toDeviceHex !== ownDeviceHex) {
    const forwardedCommand = {
      ...request.command,
      params: {
        ...request.command.params,
        "on-behalf-of": senderHex,
      },
    };
    const forwarded = deps.forwardToLocalPeer(
      toDeviceHex,
      forwardedCommand,
      request.scope,
      request.token,
    );
    if (forwarded !== undefined) {
      const outcome = await forwarded;
      await request.respond(outcome).catch(() => undefined);
      return;
    }
  }
  await deps.handleRoomRequest(request, handle);
}

/** A state_sync or state_update carries authority to directly overwrite or patch this side's own mesh state (agents, rooms, messages, deliveries) -- on an ordinary peer session that authority is meaningful because the peer already passed connect_request/introduce approval or the coordinator's own trusted mesh membership. A hub-relayed sender has passed neither, and gateway trust (agent-comms#156, dispatchHubRequest's own isTrusted gate for the legacy frame path) doesn't grant it either: being on the allowlist means "this device's traffic is worth acting on," not "this device may directly overwrite this side's mesh state" -- a strictly stronger claim no hub-relayed sender has ever been asked to prove, since the hub itself still accepts any self-generated identity with no admission control of its own (gating the hub is deliberately out of scope for agent-comms#156). Treating a trusted sender's state_sync/state_update as equally authoritative would let it inject an outcome indistinguishable from a genuine mesh event, e.g. a spoofed inbound delivery -- so this filter stays unconditional, applied even to a sender dispatchHubRequest has already let past the trust gate. Every other legacy message method this session might relay is already inert on receipt (PeerLifecycle's own handleDataMessage only reacts to these two), so filtering exactly these two is a complete fix for this specific path, not a partial one. */
function isStateMutatingMessage(message: MeshMessage): boolean {
  return message.method === "state_sync" || message.method === "state_update";
}

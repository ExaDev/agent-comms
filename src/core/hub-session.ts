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
import {
  ROOM_REQUEST_TIMEOUT_MS,
  manageRequestTimeoutMs,
} from "./request-timeouts.js";
import type { RoomRequestOrigin } from "./room-router.js";
import { connectWsUrl } from "./ws-dial.js";
import { DOMAIN, FRAME_VERB } from "./wire-mesh-transport.js";

/** How long a room-domain request routed through the hub's relay-connect/relay-data pairing waits for a response before giving up. Unlike an ordinary local peer session, a relay-connect naming an unknown target-device is silently dropped by the hub (spec/relay-hub's own documented behaviour -- no error frame exists for "no such device"), so a request to a device that turns out not to be reachable via any gateway would otherwise hang forever rather than surfacing as a normal "not reachable" outcome. */

export interface HubSessionDeps {
  /** How long a room.join sent through this session may await a human decision at the receiving end -- see manageRequestTimeoutMs. */
  roomJoinApprovalTimeoutMs: number;
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
  /** Dispatches an already-received, non-legacy-frame request (a real core/room verb: room.send, room.notify, room.join, ...) to WireMeshTransport's own roomRouter, the identical dispatch a local peer session's own drainSession already uses -- the outbound half of agent-comms#155's "remote to local" routing leg. Deferred the same lazy-`this`-capture way DeliveryEngine's own sendRoomRequestToMember closure is, since roomRouter is constructed after this class's own instance in WireMeshTransport's constructor. Declared with the identical (request, handle, origin?) shape RoomRouter.handleRequest itself has (agent-comms#216) so WireMeshTransport can keep wiring this dep as a direct method reference rather than a wrapper -- dispatchHubRequest below is what actually supplies a non-empty origin, carrying this side's own dialled hub address. */
  handleRoomRequest: (
    request: IncomingManageRequest,
    handle: Readonly<ConnectionHandle>,
    origin?: Readonly<RoomRequestOrigin>,
  ) => Promise<void>;
  /** The gateway trust boundary (agent-comms#156): whether the given device-id (hex) is currently trusted as a bare device. It only decides which room-domain senders dispatchHubRequest records as known hub peers; a real room-domain verb's own dispatch is never gated on it at all, see dispatchHubRequest's own doc for why that is sound. connect()'s own directory-merge filter uses admitEntries below instead, not this. */
  isTrusted: (deviceHex: string) => boolean;
  /** Whether a gossiped directory entry may be merged (agent-comms#156, widened by #187 and #266): its device is trusted by id, or is itself a trusted principal's own device (agent-comms#192), or carries a membership proof a trusted principal vouches for. A gossiped advert is self-asserted, so the proof is what makes trusting a principal cover its devices; verifying one is cryptography, hence asynchronous. */
  admitEntries: (
    entries: readonly DirectoryEntry[],
  ) => Promise<DirectoryEntry[]>;
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
    // Merge the hub's directory (its catch-up arrives as the first session events) and keep refreshing it on every subsequent one. Every trusted remote entry is also surfaced via onDirectory, so the transport can merge it into its own mesh-wide knownDevices (agent-comms#155's remote-directory-merge leg). Filtered to admitEntries (agent-comms#156, widened by agent-comms#187's principal allowlist per agent-comms#192 and by #266's membership proofs) before either hubPeersKnown tracking or onDirectory sees it: an untrusted device's gossiped presence is not merely withheld from listAgents, it is never even recorded as "known" here, so nothing downstream can act on it via any path this class exposes.
    void (async () => {
      const ownHex = deviceIdToHex(identity.deviceId);
      for await (const event of session.events) {
        if (this.deps.isShuttingDown()) break;
        const remoteEntries = await this.deps.admitEntries(
          event.directory.filter(
            (entry) => deviceIdToHex(entry.device) !== ownHex,
          ),
        );
        for (const entry of remoteEntries) {
          this.hubPeersKnown.add(deviceIdToHex(entry.device));
        }
        if (remoteEntries.length > 0) this.deps.onDirectory(remoteEntries);
        if (event.state.status === "closed") break;
      }
    })().catch((error: unknown) => {
      // The merge loop must not die silently: a failure here would stop this side learning of every remote device until the hub is redialled.
      this.deps.events.onError?.(
        error instanceof Error ? error : new Error(String(error)),
      );
    });
    this.consume(session, deviceIdToHex(identity.deviceId));
    void (async () => {
      await this.watchDisconnect(session);
    })();
  }

  /** Consumes one hub session's inbound relayed manage-requests until it ends, dispatching each in arrival order to dispatchHubRequest -- see that function's own doc for the actual per-request trust decision. Split out purely so the decision itself is directly unit-testable against fake requests/deps (hub-session-dispatch.test.ts), the same reason hub-forwarding.ts's own forwardAdvertsToHub/pushHubCatchUp are standalone functions rather than private methods. Passes this.url through as dispatchHubRequest's own hubAddress -- this side's own dialled address for the hub every request on this specific session arrived over (agent-comms#216), the answering-side equivalent of tracePath's own local.hubAddress above. */
  private consume(session: AcceptedMeshSession, ownDeviceHex: string): void {
    void (async () => {
      for await (const request of session.incomingManageRequests) {
        if (this.deps.isShuttingDown()) break;
        await dispatchHubRequest({
          request,
          ownDeviceHex,
          deps: this.deps,
          onKnownPeer: (hex) => {
            this.hubPeersKnown.add(hex);
          },
          hubAddress: this.url,
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
      manageRequestTimeoutMs(command, this.deps.roomJoinApprovalTimeoutMs),
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
      timeoutMs: timeoutMs ?? ROOM_REQUEST_TIMEOUT_MS,
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
  "isTrusted" | "handleRoomRequest" | "forwardToLocalPeer"
>;

/**
 * Decides what to do with one inbound relayed manage-request, keeping every downstream consumer's handle keyed by the SENDING device (request.fromDevice names it on relay-routed requests) rather than by this gateway, exactly as it already did for the legacy opaque-frame path and now also for a real room-domain verb (agent-comms#155's "remote to local" leg).
 *
 * A request with no fromDevice at all is refused before anything below sees it. A room-domain verb's own downstream handler (room-router.ts's resolveHandle, then a capability-token check such as verifyRoomToken) calls deviceIdFromHex on whatever handle.id it's given, which throws on anything that isn't valid hex rather than answering with an ordinary unauthorized outcome. Answering unauthorized here, before that, is what keeps this a clean, fast failure for the request's own caller instead of an unhandled rejection that would kill this session's whole drain loop.
 *
 * Only room-domain verbs are accepted over a relay at all. The legacy FRAME_VERB carriage (an opaque MeshMessage, which local peer sessions still use for mesh-state gossip) is refused here with unsupported_verb whoever sent it and whether or not that sender is trusted: a relayed sender has passed neither connect_request approval nor the coordinator's own membership, so it has no business feeding state_sync or state_update into this side's mesh state, and nothing on the relay path has any other use for a bare frame. Refusing the verb wholesale is the allow-list; there is no per-message-type list to keep in step with new MeshMessage variants (agent-comms#169, agent-comms#268).
 *
 * A real room-domain verb (room.send, room.join, room.notify, ...) is never gated on isTrusted at all (agent-comms#192): it is independently gated by its own room:member capability token, verified regardless of which transport path it arrived over, and already principal-aware since agent-comms#187 (device-membership-verification.ts's own chain-walk). Stacking the coarse bare-device allowlist in front of that check would be redundant, not protective, and for room.join specifically (the one deliberately ungated verb, whose own security model is a human decision) it would actively defeat the protocol's own intended design by never letting an untrusted device reach that approval step at all. onKnownPeer is still only called here for a sender isTrusted already recognises: reaching this branch has not yet had its own token verified (that happens inside handleRoomRequest/forwardToLocalPeer), so hubPeersKnown stays "gateway-trusted hub peers", never "every device that has sent a syntactically valid room-domain request".
 *
 * Multi-device gateway routing (agent-comms#184, wire-mesh-core 1.48.1's own IncomingManageRequest.toDevice, read directly from each relay-data frame's own to-device field rather than guessed from pairing state): when the request carries a toDevice naming a different device than ownDeviceHex, the command is first re-stamped with an on-behalf-of params field naming the true sender before forwardToLocalPeer forwards it on to that device's own local mesh session (one this gateway is directly connected to, never merely gossiped-about); room-router.ts's own resolveHandle reads that field back out on the receiving end, so the forwarded request is attributed to the true remote sender there, never to this gateway. Its outcome is relayed straight back. Only when forwardToLocalPeer finds no such local session (toDevice is absent, matches ownDeviceHex, or names a device this gateway doesn't actually front) does the request fall through to handleRoomRequest, dispatched against this side's own local mesh state, the same fallback a sender still on a pre-#184 wire-mesh-core (never stamping toDevice at all) already relied on -- and it's exactly that fallback call which carries hubAddress on to handleRoomRequest as origin.relayHubAddress (agent-comms#216), never the forwardToLocalPeer branch: a request forwarded on to a different local device is answered by that device's own session, not this gateway's hub session, so this gateway's own dialled hub address would be the wrong fact to attach to it.
 */
export async function dispatchHubRequest(options: {
  request: IncomingManageRequest;
  ownDeviceHex: string;
  deps: Readonly<HubRequestDispatchDeps>;
  onKnownPeer: (deviceHex: string) => void;
  hubAddress?: string | undefined;
}): Promise<void> {
  const { request, ownDeviceHex, deps, onKnownPeer, hubAddress } = options;
  if (request.command.verb === FRAME_VERB) {
    await request
      .respond({ result: "error", code: "unsupported_verb" })
      .catch(() => undefined);
    return;
  }

  if (request.fromDevice === undefined) {
    await request
      .respond({ result: "error", code: "unauthorized" })
      .catch(() => undefined);
    return;
  }

  const senderHex = deviceIdToHex(request.fromDevice);
  const handle: Readonly<ConnectionHandle> = { id: senderHex };

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
  await deps.handleRoomRequest(
    request,
    handle,
    hubAddress !== undefined ? { relayHubAddress: hubAddress } : {},
  );
}

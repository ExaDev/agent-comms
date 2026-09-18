/**
 * The room verb router: one drain loop per session, dispatching each incoming manage-request by verb. A legacy FRAME_VERB command (P2's opaque-payload carriage, still the only path for anything core/room doesn't yet have real semantics for) decodes and routes to the matching TransportEvents callback exactly as WireMeshTransport used to do inline; a registered room verb (room.send, room.join, ...) goes to its own handler; anything else -- an unrecognised verb, or a room verb this phase hasn't registered a handler for yet -- gets unsupported_verb rather than silence.
 *
 * core/room's own manage-command shape puts the specific action in params.verb (room.send, room.join, ...), not in the outer command.verb, which is instead the single room:member capability every ordinary membership verb shares (room.join/room.invite are ungated and carry no token at all, but still ride command.verb === "room:member" -- see spec/room.cddl and its own conformance vectors). Dispatch is therefore keyed on params.verb, not command.verb.
 *
 * Deliberately empty of real room-verb handlers in this phase (P3.3): the router itself, and the unsupported_verb fallback, are the whole deliverable here. Each later phase (P3.4 admission, P3.5 fan-out, P3.6 state-sync, P3.7 kick) registers the handlers for the verbs it implements.
 */

import type {
  AcceptedMeshSession,
  IncomingManageRequest,
  ManageOutcome,
} from "wire-mesh-core/domain/mesh-session";
import { deviceIdFromHex } from "wire-mesh-core/domain/device-id";
import { isMeshMessage } from "./wire-protocol.js";
import type { MeshMessage } from "./wire-protocol.js";
import type { ConnectionHandle, TransportEvents } from "./transport.js";
import { FRAME_VERB } from "./wire-mesh-transport.js";

/** Extracts and validates the carried MeshMessage from an incoming FRAME_VERB command. Returns undefined for anything that isn't a well-formed frame -- an unrecognised or malformed payload is dropped, not thrown. Exported for WireMeshTransport's own quarantine-gate pre-approval check (introduce/connect_request detection), the one place outside this router that still needs to decode a legacy frame directly. */
export function extractMessage(
  command: IncomingManageRequest["command"],
): MeshMessage | undefined {
  if (command.verb !== FRAME_VERB) return undefined;
  const params: unknown = command.params;
  if (typeof params !== "object" || params === null) return undefined;
  if (!("message" in params)) return undefined;
  const message: unknown = params.message;
  return isMeshMessage(message) ? message : undefined;
}

/** Routes an already-decoded legacy MeshMessage to the matching TransportEvents callback -- moved verbatim from WireMeshTransport's own former route() method. */
function routeLegacyMessage(
  handle: Readonly<ConnectionHandle>,
  message: MeshMessage,
  events: Readonly<TransportEvents>,
): void {
  switch (message.method) {
    case "introduce": {
      events.onIntroduction(handle, {
        peerId: handle.id,
        dataPort: message.dataPort,
      });
      return;
    }
    case "peer_list": {
      events.onPeerList(message.peers);
      return;
    }
    case "peer_joined": {
      events.onPeerJoined(message.peer);
      return;
    }
    case "become_coordinator": {
      events.onBecomeCoordinator(message.peerList);
      return;
    }
    case "connect_request": {
      // Only ever reaches here if a session was somehow promoted without going through WireMeshTransport's own consumeQuarantined handling of it -- can't happen given every requiresApproval accept path routes through consumeQuarantined first, kept here only so an unrecognised-in-context method fails closed rather than falling to the onMessage case below.
      return;
    }
    // Every other wire method -- mesh-state gossip (state_sync/state_update/peer_left) -- has no dedicated TransportEvents callback and falls to the generic onMessage handler, exactly as the old unconditional default case did.
    case "state_sync":
    case "state_update":
    case "peer_left": {
      events.onMessage(handle, message);
      return;
    }
    default: {
      // A peer running a newer build can send a wire method this closed union doesn't know about yet -- isMeshMessage's own runtime check only requires a string method field, deliberately looser than MeshMessage's compile-time type, so this branch is reachable at runtime even though every known case above is already covered.
      events.onMessage(handle, message);
      return;
    }
  }
}

/** Reads params.verb from an incoming command's params, or undefined if it isn't a plain object with a string verb field. */
function extractParamsVerb(params: unknown): string | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  if (!("verb" in params)) return undefined;
  return typeof params.verb === "string" ? params.verb : undefined;
}

/** Reads a command's own "on-behalf-of" extension field (open params tail, the same convention room.send's "streaming-behavior" already uses) -- present only when a trusted gateway forwarded this request on behalf of a different device than the one it physically arrived over (agent-comms#184's own hub-session.ts toDevice-forwarding leg, which stamps the hub-relayed request's real fromDevice here before handing it to a local peer's own session). Returns undefined for anything that isn't a well-formed device-id-hex string, so a malformed or absent value silently falls back to the connection's own authenticated identity rather than ever producing a broken handle. */
function onBehalfOfFromParams(params: unknown): string | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  if (!("on-behalf-of" in params)) return undefined;
  const claimed = params["on-behalf-of"];
  if (typeof claimed !== "string") return undefined;
  try {
    deviceIdFromHex(claimed);
  } catch {
    return undefined;
  }
  return claimed;
}

/** Resolves the handle a request is actually dispatched with: the session's own authenticated connection identity, unless allowOnBehalfOf permits substituting a claimed "on-behalf-of" device from the request's own params. allowOnBehalfOf is true only when the session's peer identity matches this side's own recorded coordinator device (wire-mesh-transport.ts's consumeIncoming, keyed on identity rather than on which specific session connectToCoordinator itself dialled, since mesh formation's own reciprocal connectToPeer can reach this side over a second, independently-accepted connection to that identical device) -- the one relationship in this mesh where the far end already holds unconditional trust over this session (the pre-existing ungated introduce/coordinator-handoff path), the same trust boundary that lets it forward a hub-relayed request on to a different local peer at all. Safe for a capability-token-gated verb (room.send, ...) regardless: the token's own bearer is independently verified against the resolved handle, so a forged claim here would simply fail that check rather than succeed under a false identity -- this only changes outcomes for the ungated room.join first round, where the coordinator relationship is the sole trust boundary either way. */
function resolveHandle(
  request: IncomingManageRequest,
  handle: Readonly<ConnectionHandle>,
  allowOnBehalfOf: boolean,
): Readonly<ConnectionHandle> {
  if (!allowOnBehalfOf) return handle;
  const claimed = onBehalfOfFromParams(request.command.params);
  if (claimed === undefined) return handle;
  return {
    id: claimed,
    ...(handle.policy !== undefined ? { policy: handle.policy } : {}),
  };
}

/** Extra facts about a request's own transport-level origin that a room-verb handler may need beyond its resolved ConnectionHandle -- currently just the hub-relay address, since RoomVerbHandler's own (request, handle) shape has no way to reach "which raw session/connection this arrived on" (agent-comms#216). Every field is optional, and every call site with nothing to report supplies an empty object rather than omitting origin altogether -- only the hub-relayed dispatch path (dispatchHubRequest, hub-session.ts) has ever anything to report here. */
export interface RoomRequestOrigin {
  /** This side's own dialled address for the hub this request was relayed through, when relayed and known -- the answering side's equivalent of wire-mesh-core's own TracePathOptions.localHubAddress/PathTraceLocal.hubAddress on the sending side. Read directly off HubSession's own currently-dialled URL by dispatchHubRequest's caller (HubSession.consume), the one place that both receives the raw hub session and knows this fact -- never rederived here. */
  relayHubAddress?: string;
}

/** Handles one already-verified-and-approved incoming request, given its authenticated connection handle and this request's own transport-level origin. Registered per params.verb (room.send, room.join, ...), never per command.verb (the shared room:member capability every ordinary membership verb rides under) -- see this file's own header comment. origin is optional here (mirroring handleRequest's own optionality below) rather than required, since most existing handlers never look at it and a good number of tests call a handler value straight out of roomVerbHandlers with just (request, handle) -- only path.trace's own handler (mesh-graph.ts) actually reads it, and does so via an optional-chained read rather than assuming it is always supplied. */
export type RoomVerbHandler = (
  request: IncomingManageRequest,
  handle: Readonly<ConnectionHandle>,
  origin?: Readonly<RoomRequestOrigin>,
) => Promise<ManageOutcome>;

export interface RoomRouterOptions {
  /** The legacy TransportEvents callbacks, still the only path for anything core/room doesn't yet have real semantics for. */
  events: TransportEvents;
  /** Room-verb handlers, keyed by params.verb. Empty in P3.3 -- each later phase registers the verbs it implements. */
  handlers?: Partial<Record<string, RoomVerbHandler>>;
}

export interface RoomRouter {
  /** Handles one already-received request. Exported for direct unit testing; drainSession below is the thin per-session loop wrapper real callers use. origin defaults to an empty object (nothing to report) when omitted -- an ordinary local peer session's own call sites (drainSession, WireMeshTransport's consumeQuarantined) never have anything to supply here; only the hub-relayed dispatch path (hub-session.ts's dispatchHubRequest, which calls this directly as its own handleRoomRequest dep) ever passes a real one. */
  handleRequest: (
    request: IncomingManageRequest,
    handle: Readonly<ConnectionHandle>,
    origin?: Readonly<RoomRequestOrigin>,
  ) => Promise<void>;
  /** Consumes one session's incomingManageRequests until it ends, dispatching each request via handleRequest. Becomes the single consumer of that iterable from this point on -- the caller must not also iterate the same session's incomingManageRequests itself once this is called. allowOnBehalfOf (default false) permits resolveHandle's own "on-behalf-of" substitution for every request on this session -- wire-mesh-transport.ts's consumeIncoming passes true only when this session's peer identity matches this side's own recorded coordinator device (see resolveHandle's own doc comment for why identity, not call site, is what's checked). */
  drainSession: (
    session: AcceptedMeshSession,
    handle: Readonly<ConnectionHandle>,
    allowOnBehalfOf?: boolean,
  ) => void;
}

export function createRoomRouter(options: RoomRouterOptions): RoomRouter {
  async function handleRequest(
    request: IncomingManageRequest,
    handle: Readonly<ConnectionHandle>,
    origin: Readonly<RoomRequestOrigin> = {},
  ): Promise<void> {
    if (request.command.verb === FRAME_VERB) {
      const message = extractMessage(request.command);
      if (message !== undefined) {
        routeLegacyMessage(handle, message, options.events);
      }
      await request.respond({ result: "ok" }).catch(() => undefined);
      return;
    }

    const verb = extractParamsVerb(request.command.params);
    const handler = verb !== undefined ? options.handlers?.[verb] : undefined;
    if (handler === undefined) {
      await request
        .respond({ result: "error", code: "unsupported_verb" })
        .catch(() => undefined);
      return;
    }
    const outcome = await handler(request, handle, origin);
    await request.respond(outcome).catch(() => undefined);
  }

  return {
    handleRequest,
    drainSession(session, handle, allowOnBehalfOf = false) {
      void (async () => {
        for await (const request of session.incomingManageRequests) {
          await handleRequest(
            request,
            resolveHandle(request, handle, allowOnBehalfOf),
          );
        }
      })();
    },
  };
}

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
  handle: ConnectionHandle,
  message: MeshMessage,
  events: TransportEvents,
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
      // Only ever reaches here if a session was somehow promoted without going through WireMeshTransport's own consumeQuarantined handling of it -- can't happen given every requiresApproval accept path routes through consumeQuarantined first, kept here only so an unrecognised-in-context method fails closed rather than falling to the default onMessage case below.
      return;
    }
    default: {
      events.onMessage(handle, message);
    }
  }
}

/** Reads params.verb from an incoming command's params, or undefined if it isn't a plain object with a string verb field. */
function extractParamsVerb(params: unknown): string | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  if (!("verb" in params)) return undefined;
  return typeof params.verb === "string" ? params.verb : undefined;
}

/** Handles one already-verified-and-approved incoming request, given its authenticated connection handle. Registered per params.verb (room.send, room.join, ...), never per command.verb (the shared room:member capability every ordinary membership verb rides under) -- see this file's own header comment. */
export type RoomVerbHandler = (
  request: IncomingManageRequest,
  handle: ConnectionHandle,
) => Promise<ManageOutcome>;

export interface RoomRouterOptions {
  /** The legacy TransportEvents callbacks, still the only path for anything core/room doesn't yet have real semantics for. */
  events: TransportEvents;
  /** Room-verb handlers, keyed by params.verb. Empty in P3.3 -- each later phase registers the verbs it implements. */
  handlers?: Partial<Record<string, RoomVerbHandler>>;
}

export interface RoomRouter {
  /** Handles one already-received request. Exported for direct unit testing; drainSession below is the thin per-session loop wrapper real callers use. */
  handleRequest: (
    request: IncomingManageRequest,
    handle: ConnectionHandle,
  ) => Promise<void>;
  /** Consumes one session's incomingManageRequests until it ends, dispatching each request via handleRequest. Becomes the single consumer of that iterable from this point on -- the caller must not also iterate the same session's incomingManageRequests itself once this is called. */
  drainSession: (
    session: AcceptedMeshSession,
    handle: ConnectionHandle,
  ) => void;
}

export function createRoomRouter(options: RoomRouterOptions): RoomRouter {
  async function handleRequest(
    request: IncomingManageRequest,
    handle: ConnectionHandle,
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
    const outcome = await handler(request, handle);
    await request.respond(outcome).catch(() => undefined);
  }

  return {
    handleRequest,
    drainSession(session, handle) {
      void (async () => {
        for await (const request of session.incomingManageRequests) {
          await handleRequest(request, handle);
        }
      })();
    },
  };
}

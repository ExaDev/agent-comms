/**
 * CapabilityAskAdmission — the ask tier surfaced at the tool layer (agent-comms#165): the generic, capability-agnostic counterpart to RoomProtocol's own pendingRoomJoins and ConnectionApproval's own pendingInboundConnections, built directly on wire-mesh-core's createCapabilityRequestHandler (the ask primitive agent-comms#164's own bubble-up module already builds on top of, wire-mesh#78). Three tiers exist at the tool layer for whether an action gets a capability token: allow (a held token already answers canGrant), deny (canGrant says no and resolveBubbleUpRoute finds no route to bubble the ask up to either), and ask -- a capability-request held open pending a human decision, which is what this module gives a name and a surface to. A capability-gated verb that lands in that third tier registers a handler built by createAskHandler below instead of failing outright: the request is held open exactly as core/room's own room.join admission holds one open, surfaced to the owning agent as a capability_request delivery event a human can act on (the approval prompt), and the outcome (acceptCapabilityRequest/rejectCapabilityRequest) resolves the held request in place, minting the granted token on acceptance -- the same accept/reject/list shape room_accept/room_reject/room_pending and mesh_accept/mesh_reject/mesh_pending already establish in tool.ts, generalised the way the issue's own framing asks for ("mirror its shape for capability requests generally"). With only one user-principal identity per machine today (agent-comms#160/#161), "the right device or principal" the issue's own framing anticipates routing an ask to is currently always this device -- the same simplification core/room's own single-decision-maker admission already makes; createAskHandler is the integration point a future capability-gated verb (e.g. agent-comms#162's dm:send) registers against its own session to get a ready `(incoming) => Promise<void>` handler backed by this admission's live pending state.
 */

import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { createCapabilityRequestHandler } from "wire-mesh-core/domain/capability-request";
import type {
  CapabilityGrantRequestEvent,
  CapabilityGrantDecision,
} from "wire-mesh-core/domain/capability-request";
import type { IncomingManageRequest } from "wire-mesh-core/domain/mesh-session";
import type {
  CapabilityScope,
  DeviceId,
} from "wire-mesh-core/generated/protocol";
import type { Clock } from "wire-mesh-core/ports/clock";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import { nanoid } from "./nanoid.js";
import { CommsError } from "./store.js";
import type { DeliveryEngine } from "./delivery-engine.js";
import type { DeliveryEvent } from "./types.js";

/** The state and collaborators CapabilityAskAdmission needs from MeshStore -- getPeerId/getOnDelivery/queueDelivery mirror ConnectionApprovalDeps exactly, since surfacing a capability_request event to the owning agent is the identical "queue it, then push it live if a callback is registered" mechanism connection_request already uses. */
export interface CapabilityAskAdmissionDeps {
  getPeerId: () => string;
  getOnDelivery: () =>
    | ((agentId: string, event: DeliveryEvent) => void | Promise<void>)
    | undefined;
  queueDelivery: DeliveryEngine["queueDelivery"];
}

export interface CreateCapabilityAskHandlerOptions {
  /** The capability this handler surfaces asks for -- one handler per capability, the same convention createCapabilityRequestHandler and createBubbleUpCapabilityRequestHandler already establish. */
  capability: string;
  identity: IdentityPort;
  clock: Clock;
  /** The peer device-id authenticated on this session's own connection -- the requester, and so the future bearer of any token accepting the ask mints. */
  bearerDevice: DeviceId;
  /** Receiver-side auto-reject window (wire-mesh#81): how long the ask may sit awaiting a human decision before wire-mesh-core's own createCapabilityRequestHandler responds with a manage-error timeout on this admission's behalf. */
  timeoutMs: number;
}

interface PendingCapabilityAsk {
  capability: string;
  scope: Readonly<CapabilityScope>;
  requesterDevice: DeviceId;
  decide: (decision: Readonly<CapabilityGrantDecision>) => Promise<void>;
}

export class CapabilityAskAdmission {
  private readonly pending = new Map<string, PendingCapabilityAsk>();

  constructor(private readonly deps: Readonly<CapabilityAskAdmissionDeps>) {}

  /** Builds a manage-request handler for one capability's incoming capability-requests that never decides on its own: every not-malformed, not-yet-expired ask is held open and surfaced as a capability_request delivery event, exactly like handleConnectionRequest already does for an inbound mesh connection. */
  createAskHandler(
    options: Readonly<CreateCapabilityAskHandlerOptions>,
  ): (incoming: Readonly<IncomingManageRequest>) => Promise<void> {
    return createCapabilityRequestHandler({
      capability: options.capability,
      identity: options.identity,
      clock: options.clock,
      bearerDevice: options.bearerDevice,
      timeoutMs: options.timeoutMs,
      onRequest: (event: Readonly<CapabilityGrantRequestEvent>) => {
        this.handleCapabilityRequest(options.capability, event);
      },
    });
  }

  private handleCapabilityRequest(
    capability: string,
    event: Readonly<CapabilityGrantRequestEvent>,
  ): void {
    const requestId = nanoid();
    this.pending.set(requestId, {
      capability,
      scope: event.scope,
      requesterDevice: event.requesterDevice,
      decide: event.decide,
    });

    const deliveryEvent: DeliveryEvent = {
      type: "capability_request",
      requestId,
      capability,
      scopeKind: event.scope.kind,
      ...(event.scope.path !== undefined
        ? { scopePath: event.scope.path }
        : {}),
      requesterDevice: deviceIdToHex(event.requesterDevice),
    };
    const peerId = this.deps.getPeerId();
    this.deps.queueDelivery(peerId, deliveryEvent);
    const onDelivery = this.deps.getOnDelivery();
    if (onDelivery) {
      void onDelivery(peerId, deliveryEvent);
    }
  }

  /** Every capability-request currently held open awaiting a human decision. */
  listPendingCapabilityRequests(): {
    requestId: string;
    capability: string;
    scopeKind: string;
    scopePath?: string;
    requesterDevice: string;
  }[] {
    return [...this.pending.entries()].map(([requestId, ask]) => ({
      requestId,
      capability: ask.capability,
      scopeKind: ask.scope.kind,
      ...(ask.scope.path !== undefined ? { scopePath: ask.scope.path } : {}),
      requesterDevice: deviceIdToHex(ask.requesterDevice),
    }));
  }

  /** Approves a pending capability-request, resolving its held decide() with an accept -- wire-mesh-core's own createCapabilityRequestHandler mints the granted token and responds on this admission's behalf. `capability`, when given, grants something narrower than what was originally asked for (the primitive's own CapabilityGrantDecision allows this); absent, the request's own originally-asked-for capability is granted unchanged. */
  async acceptCapabilityRequest(
    requestId: string,
    options: Readonly<{
      expires: number;
      delegationsRemaining?: number;
      capability?: string;
    }>,
  ): Promise<void> {
    const pending = this.requirePending(requestId);
    this.pending.delete(requestId);
    await pending.decide({
      kind: "accept",
      capability: options.capability ?? pending.capability,
      expires: options.expires,
      ...(options.delegationsRemaining !== undefined
        ? { delegationsRemaining: options.delegationsRemaining }
        : {}),
    });
  }

  /** Denies a pending capability-request, optionally with a reason surfaced to the requester in the resulting manage-error's own message field. */
  async rejectCapabilityRequest(
    requestId: string,
    reason?: string,
  ): Promise<void> {
    const pending = this.requirePending(requestId);
    this.pending.delete(requestId);
    await pending.decide({
      kind: "reject",
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  private requirePending(requestId: string): PendingCapabilityAsk {
    const pending = this.pending.get(requestId);
    if (pending === undefined) {
      throw new CommsError(
        `No pending capability request ${requestId}`,
        "NOT_PENDING",
      );
    }
    return pending;
  }
}

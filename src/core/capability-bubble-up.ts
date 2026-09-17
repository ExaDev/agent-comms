/**
 * The routing policy for the ask tier's escalation path (agent-comms#164): walking a held capability token's own issuer chain when the immediate holder cannot grant a request itself. wire-mesh's capability-request primitive (domain/capability-request.ts) already carries the ask/held-open/decide/mint mechanics of a single hop; gossip-advertised grant candidates (domain/grant-candidates.ts) already answer "who nearer than the root can grant" for a requester picking its first hop. Neither decides what an intermediate device, having received a request it cannot fully satisfy from its own authority, should do next: that per-hop decision, and the handler that acts on it by minting a delegated child or forwarding the same ask further up the chain, is what this module adds.
 *
 * Two responsibilities, split the same way capability-request.ts already splits its own: resolveBubbleUpRoute is the pure decision (grant from held depth, forward to the held token's own issuer, or no-route), and createBubbleUpCapabilityRequestHandler is the wire-facing orchestration that acts on it. Deliberately built directly on wire-mesh's exported mintCapabilityToken rather than reusing createCapabilityRequestHandler's own decide(): that primitive's accept path always mints a root token (no `parent`), which is correct for the primitive's own reference consumer (a room owner minting membership tokens directly) but cannot express "mint a narrower child of the token I already hold", the one thing granting from delegated depth actually requires.
 */

import { buildCapabilityRequestCommand } from "wire-mesh-core/domain/capability-request";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import type {
  MeshSession,
  IncomingManageRequest,
} from "wire-mesh-core/domain/mesh-session";
import {
  canGrant,
  mintCapabilityToken,
  verifyCapabilityToken,
  type RevocationCheck,
} from "wire-mesh-core/domain/tokens";
import {
  capabilityGrantOkSchema,
  capabilityRequestSchema,
  type CapabilityScope,
  type CapabilityToken,
  type DeviceId,
} from "wire-mesh-core/generated/protocol";
import type { Clock } from "wire-mesh-core/ports/clock";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import { randomId } from "./random-id.js";

export interface ResolveBubbleUpRouteOptions {
  /** This device's own held credential establishing its authority over `capability`/`scope`, if it holds one at all. A device with none is either the capability's own structural root (which mints fresh from its own identity, outside this module's concern -- see wire-mesh's own createCapabilityRequestHandler for that path) or genuinely has nothing to grant or forward from. */
  heldToken: CapabilityToken | undefined;
  /** This device's own identity: both the crypto primitives heldToken is verified with, and (via `.deviceId`) the bearer heldToken must actually name. */
  identity: IdentityPort;
  clock: Clock;
  revocation: RevocationCheck;
  /** The capability and scope the incoming ask is for -- forwarded unchanged from the request this route decides for. */
  capability: string;
  scope: Readonly<CapabilityScope>;
  /** The expiry and delegation depth a grant would carry if minted at this hop, checked against heldToken's own narrowing bounds via canGrant. The caller (see createBubbleUpCapabilityRequestHandler) owns this policy; this module only evaluates it. */
  expires: number;
  delegationsRemaining?: number;
}

export type BubbleUpRoute =
  | { kind: "grant"; token: CapabilityToken }
  | { kind: "forward"; target: DeviceId }
  | {
      kind: "no-route";
      reason: "no-held-token" | "held-token-invalid" | "self-issued";
    };

/**
 * Decides, for one device holding (or not holding) a capability token, whether it can grant a request for `capability`/`scope`/`expires`/`delegationsRemaining` from its own held depth, must forward the same ask to whoever issued its own token, or has no route to a grantor at all.
 *
 * heldToken is independently verified here (signature, expiry, revocation, and that this device is genuinely its bearer) via verifyCapabilityToken rather than trusted as already-checked: a caller's own held-token cache can go stale (expiry, a since-recorded revocation) between when it was stored and when this decision runs, and granting or forwarding on an invalid credential would be a real authority leak, not merely a stale-read symptom.
 *
 * Ordering matches the issue's own framing (agent-comms#164): a device with real remaining depth grants outright (checked via canGrant, the same narrowing arithmetic mintCapabilityToken itself enforces, so this decision and the mint it authorises can never disagree); otherwise, absent a nearer route this module has no way to discover on its own (see grant-candidates.ts for the requester's own gossip-based shortcut, deliberately a separate concern), the only further hop toward the root a token's own claims expose is its issuer. Forwarding to that issuer when it is this very device (a self-issued token, which canGrant already found could not satisfy the request) would loop forever, so that case reports no-route instead.
 */
export async function resolveBubbleUpRoute(
  options: Readonly<ResolveBubbleUpRouteOptions>,
): Promise<BubbleUpRoute> {
  if (options.heldToken === undefined) {
    return { kind: "no-route", reason: "no-held-token" };
  }

  const verdict = await verifyCapabilityToken(options.heldToken, {
    identity: options.identity,
    clock: options.clock,
    revocation: options.revocation,
    expectedBearer: options.identity.deviceId,
  });
  if (!verdict.ok) {
    return { kind: "no-route", reason: "held-token-invalid" };
  }

  const canGrantDirectly = await canGrant(
    options.heldToken,
    options.identity.deviceId,
    {
      capability: options.capability,
      scope: options.scope,
      expires: options.expires,
      ...(options.delegationsRemaining !== undefined
        ? { delegationsRemaining: options.delegationsRemaining }
        : {}),
    },
    options.clock.now(),
  );
  if (canGrantDirectly) {
    return { kind: "grant", token: options.heldToken };
  }

  if (
    deviceIdToHex(verdict.claims.issuer) ===
    deviceIdToHex(options.identity.deviceId)
  ) {
    return { kind: "no-route", reason: "self-issued" };
  }
  return { kind: "forward", target: verdict.claims.issuer };
}

export interface CreateBubbleUpCapabilityRequestHandlerOptions {
  /** The capability this handler grants or forwards asks for, checked against the incoming request's own `params.capability`. One handler is constructed per capability, the same convention capability-request.ts's own createCapabilityRequestHandler already establishes. */
  capability: string;
  identity: IdentityPort;
  clock: Clock;
  revocation: RevocationCheck;
  /** The peer device-id authenticated on this session's own connection -- the requester, and so the bearer of whichever token this handler ultimately mints (whether granted from own depth or re-delegated from an upstream grant). */
  bearerDevice: DeviceId;
  /** The expiry and delegation depth this handler mints with, at either hop (its own grant, or its re-delegation of an upstream one). A fixed per-handler policy, not per-request: the wire-level capability-request carries no requested expiry or depth of its own (management.cddl leaves both to the granter), matching the same policy CapabilityGrantDecision.expires/delegationsRemaining already leaves to the domain in wire-mesh's base primitive. */
  expires: number;
  delegationsRemaining?: number;
  /** Looks up this device's own currently held credential for `capability`, if any, at the moment each request is handled -- a function rather than a static value since a held token can be minted, renewed, or revoked over the handler's own lifetime. */
  ownToken: () => CapabilityToken | undefined;
  /** Used to forward an ask this device cannot grant itself further up the issuer chain. Only sendManageRequest is used, so a caller can supply a minimal stand-in in tests rather than a full MeshSession. */
  session: Pick<MeshSession, "sendManageRequest">;
  /** Bounds how long a forwarded ask waits for the next hop's own answer, forwarded directly to sendManageRequest's own identically-named parameter. Absent, a forward waits with no time limit of its own, exactly as sendManageRequest already behaves. */
  forwardTimeoutMs?: number;
}

/**
 * Builds a reusable handler for one capability's incoming capability-requests that answers each one by walking the issuer chain: grant a delegated child from this device's own held depth when resolveBubbleUpRoute says it can, forward the identical ask to the held token's own issuer and re-delegate whatever grant comes back when it cannot, or refuse outright when there is no route to a grantor at all.
 *
 * Parses and validates the incoming request the same way capability-request.ts's own createCapabilityRequestHandler does (wrong capability or malformed payload refuses `{result:"error",code:"malformed"}`; an already-expired `valid-until` refuses `{result:"error",code:"expired"}`), so a requester using the ordinary requestCapability wrapper sees identical wire behaviour from either handler.
 *
 * A forward's own upstream outcome is relayed verbatim on refusal (the exact code and message an intermediate or root grantor sent), rather than collapsed to a generic denial, so the original requester learns exactly what stopped the chain. A forward's own granted token is independently re-verified (expectedBearer this device's own identity) before being trusted as a mint parent: mintCapabilityToken's own `parent` handling only checks structural narrowing against the decoded claims, not the token's signature, expiry, or revocation status, so an unverified inbound grant would otherwise let a malicious or buggy upstream peer hand this device a bogus credential to unknowingly re-delegate.
 */
export function createBubbleUpCapabilityRequestHandler(
  options: Readonly<CreateBubbleUpCapabilityRequestHandlerOptions>,
): (incoming: Readonly<IncomingManageRequest>) => Promise<void> {
  return async function handleBubbleUpCapabilityRequest(
    incoming: Readonly<IncomingManageRequest>,
  ): Promise<void> {
    const parsed = capabilityRequestSchema.safeParse(incoming.command.params);
    if (!parsed.success || parsed.data.capability !== options.capability) {
      await incoming.respond({ result: "error", code: "malformed" });
      return;
    }
    const validUntil = parsed.data["valid-until"];
    if (validUntil !== undefined && validUntil <= options.clock.now()) {
      await incoming.respond({ result: "error", code: "expired" });
      return;
    }

    const route = await resolveBubbleUpRoute({
      heldToken: options.ownToken(),
      identity: options.identity,
      clock: options.clock,
      revocation: options.revocation,
      capability: options.capability,
      scope: incoming.scope,
      expires: options.expires,
      ...(options.delegationsRemaining !== undefined
        ? { delegationsRemaining: options.delegationsRemaining }
        : {}),
    });

    if (route.kind === "grant") {
      await mintAndRespond(options, incoming, route.token);
      return;
    }

    if (route.kind === "forward") {
      const forwardOutcome = await options.session.sendManageRequest(
        buildCapabilityRequestCommand(options.capability, validUntil),
        incoming.scope,
        route.target,
        undefined,
        options.forwardTimeoutMs,
      );
      if (forwardOutcome.result !== "ok") {
        await incoming.respond(forwardOutcome);
        return;
      }
      const parsedGrant = capabilityGrantOkSchema.safeParse(forwardOutcome);
      if (!parsedGrant.success) {
        await incoming.respond({ result: "error", code: "malformed" });
        return;
      }
      const upstreamVerdict = await verifyCapabilityToken(
        parsedGrant.data["granted-token"],
        {
          identity: options.identity,
          clock: options.clock,
          revocation: options.revocation,
          expectedBearer: options.identity.deviceId,
        },
      );
      if (!upstreamVerdict.ok) {
        await incoming.respond({
          result: "error",
          code: upstreamVerdict.reason,
        });
        return;
      }
      await mintAndRespond(
        options,
        incoming,
        parsedGrant.data["granted-token"],
      );
      return;
    }

    await incoming.respond({
      result: "error",
      code: "denied",
      message: `no route to a grantor for "${options.capability}"`,
    });
  };
}

/** Mints a delegated child of `parent` (this device's own held token, or a freshly re-verified upstream grant) for the requester, and responds with it -- shared by both createBubbleUpCapabilityRequestHandler branches that end in a mint, so the two can never drift into two different ideas of what the resulting token should carry. */
async function mintAndRespond(
  options: Readonly<CreateBubbleUpCapabilityRequestHandlerOptions>,
  incoming: Readonly<IncomingManageRequest>,
  parent: CapabilityToken,
): Promise<void> {
  const verdict = await mintCapabilityToken({
    identity: options.identity,
    clock: options.clock,
    tokenId: randomId(),
    bearer: options.bearerDevice,
    capability: options.capability,
    scope: incoming.scope,
    expires: options.expires,
    ...(options.delegationsRemaining !== undefined
      ? { delegationsRemaining: options.delegationsRemaining }
      : {}),
    parent,
  });
  if (!verdict.ok) {
    await incoming.respond({ result: "error", code: "mint_failed" });
    return;
  }
  await incoming.respond({ result: "ok", "granted-token": verdict.token });
}

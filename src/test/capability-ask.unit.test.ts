/**
 * Direct, DI-based unit tests for CapabilityAskAdmission -- mirrors connection-approval.test.ts's own approach (a narrow, injectable deps surface, fake collaborators via vi.fn()) so every branch of the ask tier's tool-layer surfacing (agent-comms#165) is asserted on directly rather than only indirectly through a live transport.
 */
import { webcrypto } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import { createNodeIdentity } from "wire-mesh-core/adapters/node-identity";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { verifyCapabilityToken } from "wire-mesh-core/domain/tokens";
import { createRevocationView } from "wire-mesh-core/domain/revocation-view";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import type { Clock } from "wire-mesh-core/ports/clock";
import type { IncomingManageRequest } from "wire-mesh-core/domain/mesh-session";
import {
  CapabilityAskAdmission,
  type CapabilityAskAdmissionDeps,
} from "../core/capability-ask.js";
import type { DeliveryEvent } from "../core/types.js";

const ES256 = -7;
const NOW_MS = 1_893_456_000_000;
const HOUR_MS = 3_600_000;
const EXPIRES_MS = NOW_MS + HOUR_MS;
const CAPABILITY = "dm:send";
const SCOPE = { kind: "user" as const };
const OWNER_ID = "owner-peer";

async function generateEs256Identity(): Promise<IdentityPort> {
  const keyPair = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKeyBytes = new Uint8Array(
    await webcrypto.subtle.exportKey("raw", keyPair.publicKey),
  );
  return createNodeIdentity(keyPair.privateKey, publicKeyBytes, ES256);
}

function fixedClock(atMs: number): Clock {
  return { now: () => atMs };
}

interface Harness {
  deps: CapabilityAskAdmissionDeps;
  admission: CapabilityAskAdmission;
  queueDelivery: ReturnType<typeof vi.fn>;
  onDelivery: ReturnType<typeof vi.fn> | undefined;
}

function makeHarness(
  options: Readonly<{ withOnDelivery?: boolean }> = {},
): Harness {
  const queueDelivery = vi.fn<CapabilityAskAdmissionDeps["queueDelivery"]>();
  const onDelivery = options.withOnDelivery === true ? vi.fn() : undefined;
  const deps: CapabilityAskAdmissionDeps = {
    getPeerId: () => OWNER_ID,
    getOnDelivery: () => onDelivery,
    queueDelivery,
  };
  return {
    deps,
    admission: new CapabilityAskAdmission(deps),
    queueDelivery,
    onDelivery,
  };
}

type FakeIncoming = IncomingManageRequest & {
  respond: ReturnType<typeof vi.fn>;
};

let nextRequestId = 0;
function fakeIncoming(params: Record<string, unknown>): FakeIncoming {
  nextRequestId += 1;
  return {
    requestId: nextRequestId,
    command: { verb: CAPABILITY, params },
    scope: SCOPE,
    respond: vi.fn(async () => undefined),
  };
}

describe("CapabilityAskAdmission — createAskHandler", () => {
  it("holds the request open, queues a capability_request delivery event, and touches neither respond nor onDelivery's own callback synchronously", async () => {
    const h = makeHarness({ withOnDelivery: true });
    const identity = await generateEs256Identity();
    const requester = await generateEs256Identity();

    const handler = h.admission.createAskHandler({
      capability: CAPABILITY,
      identity,
      clock: fixedClock(NOW_MS),
      bearerDevice: requester.deviceId,
      timeoutMs: HOUR_MS,
    });

    const incoming = fakeIncoming({
      verb: "capability.request",
      capability: CAPABILITY,
    });
    // The handler awaits only until onRequest is called, never until decide() settles -- the ask stays held open, so this resolves without ever calling respond().
    await handler(incoming);

    expect(incoming.respond).not.toHaveBeenCalled();
    expect(h.queueDelivery).toHaveBeenCalledTimes(1);
    const [deliveredTo, event] = h.queueDelivery.mock.calls[0] as [
      string,
      DeliveryEvent,
    ];
    expect(deliveredTo).toBe(OWNER_ID);
    expect(event).toEqual({
      type: "capability_request",
      requestId: expect.any(String),
      capability: CAPABILITY,
      scopeKind: "user",
      requesterDevice: deviceIdToHex(requester.deviceId),
    });
    expect(h.onDelivery).toHaveBeenCalledTimes(1);
  });

  it("includes scopePath in the delivery event when the incoming request's own scope carries one", async () => {
    const h = makeHarness();
    const identity = await generateEs256Identity();
    const requester = await generateEs256Identity();

    const handler = h.admission.createAskHandler({
      capability: CAPABILITY,
      identity,
      clock: fixedClock(NOW_MS),
      bearerDevice: requester.deviceId,
      timeoutMs: HOUR_MS,
    });

    nextRequestId += 1;
    const incoming: FakeIncoming = {
      requestId: nextRequestId,
      command: {
        verb: CAPABILITY,
        params: { verb: "capability.request", capability: CAPABILITY },
      },
      scope: { kind: "room", path: "abc/general" },
      respond: vi.fn(async () => undefined),
    };
    await handler(incoming);

    const [, event] = h.queueDelivery.mock.calls[0] as [string, DeliveryEvent];
    expect(event).toMatchObject({
      scopeKind: "room",
      scopePath: "abc/general",
    });
  });

  it("responds malformed for a request naming a different capability, and never surfaces it as a pending ask", async () => {
    const h = makeHarness();
    const identity = await generateEs256Identity();
    const requester = await generateEs256Identity();

    const handler = h.admission.createAskHandler({
      capability: CAPABILITY,
      identity,
      clock: fixedClock(NOW_MS),
      bearerDevice: requester.deviceId,
      timeoutMs: HOUR_MS,
    });

    const incoming = fakeIncoming({
      verb: "capability.request",
      capability: "room:member",
    });
    await handler(incoming);

    expect(incoming.respond).toHaveBeenCalledWith({
      result: "error",
      code: "malformed",
    });
    expect(h.queueDelivery).not.toHaveBeenCalled();
    expect(h.admission.listPendingCapabilityRequests()).toEqual([]);
  });
});

describe("CapabilityAskAdmission — listPendingCapabilityRequests / acceptCapabilityRequest / rejectCapabilityRequest", () => {
  it("lists every still-held ask with its capability, scope, and requester", async () => {
    const h = makeHarness();
    const identity = await generateEs256Identity();
    const requester = await generateEs256Identity();
    const handler = h.admission.createAskHandler({
      capability: CAPABILITY,
      identity,
      clock: fixedClock(NOW_MS),
      bearerDevice: requester.deviceId,
      timeoutMs: HOUR_MS,
    });

    await handler(
      fakeIncoming({ verb: "capability.request", capability: CAPABILITY }),
    );

    expect(h.admission.listPendingCapabilityRequests()).toEqual([
      {
        requestId: expect.any(String),
        capability: CAPABILITY,
        scopeKind: "user",
        requesterDevice: deviceIdToHex(requester.deviceId),
      },
    ]);
  });

  it("accepting a pending ask mints a granted token, responds ok, and removes it from the pending list", async () => {
    const h = makeHarness();
    const identity = await generateEs256Identity();
    const requester = await generateEs256Identity();
    const handler = h.admission.createAskHandler({
      capability: CAPABILITY,
      identity,
      clock: fixedClock(NOW_MS),
      bearerDevice: requester.deviceId,
      timeoutMs: HOUR_MS,
    });

    const incoming = fakeIncoming({
      verb: "capability.request",
      capability: CAPABILITY,
    });
    await handler(incoming);
    const [requestId] = h.admission
      .listPendingCapabilityRequests()
      .map((p) => p.requestId);
    if (requestId === undefined) throw new Error("no pending request");

    await h.admission.acceptCapabilityRequest(requestId, {
      expires: EXPIRES_MS,
      delegationsRemaining: 1,
    });

    expect(incoming.respond).toHaveBeenCalledTimes(1);
    const outcome = incoming.respond.mock.calls[0]?.[0] as {
      result: string;
      "granted-token": Parameters<typeof verifyCapabilityToken>[0];
    };
    expect(outcome.result).toBe("ok");

    const verdict = await verifyCapabilityToken(outcome["granted-token"], {
      identity,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      expectedBearer: requester.deviceId,
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.claims.capability).toBe(CAPABILITY);
    }
    expect(h.admission.listPendingCapabilityRequests()).toEqual([]);
  });

  it("rejecting a pending ask responds denied with the given reason and removes it from the pending list", async () => {
    const h = makeHarness();
    const identity = await generateEs256Identity();
    const requester = await generateEs256Identity();
    const handler = h.admission.createAskHandler({
      capability: CAPABILITY,
      identity,
      clock: fixedClock(NOW_MS),
      bearerDevice: requester.deviceId,
      timeoutMs: HOUR_MS,
    });

    const incoming = fakeIncoming({
      verb: "capability.request",
      capability: CAPABILITY,
    });
    await handler(incoming);
    const [requestId] = h.admission
      .listPendingCapabilityRequests()
      .map((p) => p.requestId);
    if (requestId === undefined) throw new Error("no pending request");

    await h.admission.rejectCapabilityRequest(requestId, "not right now");

    expect(incoming.respond).toHaveBeenCalledWith({
      result: "error",
      code: "denied",
      message: "not right now",
    });
    expect(h.admission.listPendingCapabilityRequests()).toEqual([]);
  });

  it("rejects with no message field when no reason is given", async () => {
    const h = makeHarness();
    const identity = await generateEs256Identity();
    const requester = await generateEs256Identity();
    const handler = h.admission.createAskHandler({
      capability: CAPABILITY,
      identity,
      clock: fixedClock(NOW_MS),
      bearerDevice: requester.deviceId,
      timeoutMs: HOUR_MS,
    });

    const incoming = fakeIncoming({
      verb: "capability.request",
      capability: CAPABILITY,
    });
    await handler(incoming);
    const [requestId] = h.admission
      .listPendingCapabilityRequests()
      .map((p) => p.requestId);
    if (requestId === undefined) throw new Error("no pending request");

    await h.admission.rejectCapabilityRequest(requestId);

    expect(incoming.respond).toHaveBeenCalledWith({
      result: "error",
      code: "denied",
    });
  });

  it("throws naming the exact unknown request id when accepting, and never touches decide", async () => {
    const h = makeHarness();
    await expect(
      h.admission.acceptCapabilityRequest("no-such-request", {
        expires: EXPIRES_MS,
      }),
    ).rejects.toThrow("No pending capability request no-such-request");
  });

  it("throws naming the exact unknown request id when rejecting", async () => {
    const h = makeHarness();
    await expect(
      h.admission.rejectCapabilityRequest("no-such-request"),
    ).rejects.toThrow("No pending capability request no-such-request");
  });

  it("grants a narrower capability than requested when the accept decision names one explicitly", async () => {
    const h = makeHarness();
    const identity = await generateEs256Identity();
    const requester = await generateEs256Identity();
    const handler = h.admission.createAskHandler({
      capability: CAPABILITY,
      identity,
      clock: fixedClock(NOW_MS),
      bearerDevice: requester.deviceId,
      timeoutMs: HOUR_MS,
    });

    const incoming = fakeIncoming({
      verb: "capability.request",
      capability: CAPABILITY,
    });
    await handler(incoming);
    const [requestId] = h.admission
      .listPendingCapabilityRequests()
      .map((p) => p.requestId);
    if (requestId === undefined) throw new Error("no pending request");

    await h.admission.acceptCapabilityRequest(requestId, {
      expires: EXPIRES_MS,
      capability: "dm:send-narrow",
    });

    const outcome = incoming.respond.mock.calls[0]?.[0] as {
      result: string;
      "granted-token": Parameters<typeof verifyCapabilityToken>[0];
    };
    const verdict = await verifyCapabilityToken(outcome["granted-token"], {
      identity,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      expectedBearer: requester.deviceId,
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.claims.capability).toBe("dm:send-narrow");
    }
  });
});

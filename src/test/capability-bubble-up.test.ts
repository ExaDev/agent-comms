import { webcrypto } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import { createNodeIdentity } from "wire-mesh-core/adapters/node-identity";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { mintCapabilityToken } from "wire-mesh-core/domain/tokens";
import { createRevocationView } from "wire-mesh-core/domain/revocation-view";
import { verifyCapabilityToken } from "wire-mesh-core/domain/tokens";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import type { Clock } from "wire-mesh-core/ports/clock";
import type {
  CapabilityToken,
  ManageOutcome,
} from "wire-mesh-core/generated/protocol";
import {
  resolveBubbleUpRoute,
  createBubbleUpCapabilityRequestHandler,
} from "../core/capability-bubble-up.js";

const ES256 = -7;
const HOUR_MS = 3_600_000;
const NOW_MS = 1_893_456_000_000;
const EXPIRES_MS = NOW_MS + HOUR_MS;
const CAPABILITY = "exec:pty";
const SCOPE = { kind: "folder" as const };

function buf(bytes: Uint8Array | ArrayLike<number>): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(bytes);
}

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

let issuedTokenIds = 0;
function nextTokenId(): Uint8Array<ArrayBuffer> {
  issuedTokenIds += 1;
  return buf([issuedTokenIds]);
}

async function mint(
  issuer: IdentityPort,
  bearer: IdentityPort,
  options: {
    capability?: string;
    scope?: { kind: string; path?: string };
    expires?: number;
    delegationsRemaining?: number;
    parent?: CapabilityToken;
  } = {},
): Promise<CapabilityToken> {
  const verdict = await mintCapabilityToken({
    identity: issuer,
    clock: fixedClock(NOW_MS),
    tokenId: nextTokenId(),
    bearer: bearer.deviceId,
    capability: options.capability ?? CAPABILITY,
    scope: options.scope ?? SCOPE,
    expires: options.expires ?? EXPIRES_MS,
    ...(options.delegationsRemaining !== undefined
      ? { delegationsRemaining: options.delegationsRemaining }
      : {}),
    ...(options.parent !== undefined ? { parent: options.parent } : {}),
  });
  if (!verdict.ok) throw new Error(`mint failed: ${verdict.reason}`);
  return verdict.token;
}

describe("resolveBubbleUpRoute", () => {
  it("grants directly when the held token has depth remaining that narrows the request", async () => {
    const root = await generateEs256Identity();
    const holder = await generateEs256Identity();
    const heldToken = await mint(root, holder, { delegationsRemaining: 2 });

    const route = await resolveBubbleUpRoute({
      heldToken,
      identity: holder,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      capability: CAPABILITY,
      scope: SCOPE,
      expires: EXPIRES_MS,
      delegationsRemaining: 1,
    });

    expect(route.kind).toBe("grant");
    if (route.kind === "grant") {
      expect(route.token).toBe(heldToken);
    }
  });

  it("forwards to the held token's own issuer when its delegation depth is exhausted", async () => {
    const root = await generateEs256Identity();
    const holder = await generateEs256Identity();
    const heldToken = await mint(root, holder, { delegationsRemaining: 0 });

    const route = await resolveBubbleUpRoute({
      heldToken,
      identity: holder,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      capability: CAPABILITY,
      scope: SCOPE,
      expires: EXPIRES_MS,
      delegationsRemaining: 0,
    });

    expect(route.kind).toBe("forward");
    if (route.kind === "forward") {
      expect(deviceIdToHex(route.target)).toBe(deviceIdToHex(root.deviceId));
    }
  });

  it("forwards to the held token's own issuer when the requested scope does not narrow", async () => {
    const root = await generateEs256Identity();
    const holder = await generateEs256Identity();
    const heldToken = await mint(root, holder, {
      scope: { kind: "room", path: "abc/general" },
      delegationsRemaining: 3,
    });

    const route = await resolveBubbleUpRoute({
      heldToken,
      identity: holder,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      capability: CAPABILITY,
      scope: { kind: "room", path: "abc/other" },
      expires: EXPIRES_MS,
      delegationsRemaining: 1,
    });

    expect(route.kind).toBe("forward");
    if (route.kind === "forward") {
      expect(deviceIdToHex(route.target)).toBe(deviceIdToHex(root.deviceId));
    }
  });

  it("reports no-route when this device holds no token for the capability at all", async () => {
    const holder = await generateEs256Identity();

    const route = await resolveBubbleUpRoute({
      heldToken: undefined,
      identity: holder,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      capability: CAPABILITY,
      scope: SCOPE,
      expires: EXPIRES_MS,
    });

    expect(route).toEqual({ kind: "no-route", reason: "no-held-token" });
  });

  it("reports no-route when the held token has already expired", async () => {
    const root = await generateEs256Identity();
    const holder = await generateEs256Identity();
    const heldToken = await mint(root, holder, {
      expires: NOW_MS - 1,
      delegationsRemaining: 2,
    });

    const route = await resolveBubbleUpRoute({
      heldToken,
      identity: holder,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      capability: CAPABILITY,
      scope: SCOPE,
      expires: NOW_MS,
      delegationsRemaining: 1,
    });

    expect(route).toEqual({ kind: "no-route", reason: "held-token-invalid" });
  });

  it("reports no-route rather than forwarding to itself when its held token is self-issued", async () => {
    const holder = await generateEs256Identity();
    const heldToken = await mint(holder, holder, { delegationsRemaining: 0 });

    const route = await resolveBubbleUpRoute({
      heldToken,
      identity: holder,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      capability: CAPABILITY,
      scope: SCOPE,
      expires: EXPIRES_MS,
      delegationsRemaining: 0,
    });

    expect(route).toEqual({ kind: "no-route", reason: "self-issued" });
  });
});

interface FakeIncoming {
  command: { verb: string; params: Record<string, unknown> };
  scope: { kind: string; path?: string };
  respond: ReturnType<typeof vi.fn>;
}

function fakeIncoming(params: Record<string, unknown>): FakeIncoming {
  return {
    command: { verb: CAPABILITY, params },
    scope: SCOPE,
    respond: vi.fn(async () => undefined),
  };
}

describe("createBubbleUpCapabilityRequestHandler", () => {
  it("mints a delegated child token when this device can grant from its own held depth", async () => {
    const root = await generateEs256Identity();
    const holder = await generateEs256Identity();
    const requester = await generateEs256Identity();
    const heldToken = await mint(root, holder, { delegationsRemaining: 2 });

    const sendManageRequest = vi.fn();
    const handler = createBubbleUpCapabilityRequestHandler({
      capability: CAPABILITY,
      identity: holder,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      bearerDevice: requester.deviceId,
      expires: EXPIRES_MS,
      delegationsRemaining: 1,
      ownToken: () => heldToken,
      session: { sendManageRequest },
    });

    const incoming = fakeIncoming({
      verb: "capability.request",
      capability: CAPABILITY,
    });
    await handler(incoming);

    expect(sendManageRequest).not.toHaveBeenCalled();
    expect(incoming.respond).toHaveBeenCalledTimes(1);
    const outcome = incoming.respond.mock.calls[0]?.[0] as {
      result: string;
      "granted-token": CapabilityToken;
    };
    expect(outcome.result).toBe("ok");

    const verdict = await verifyCapabilityToken(outcome["granted-token"], {
      identity: holder,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      expectedBearer: requester.deviceId,
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(deviceIdToHex(verdict.rootIssuer)).toBe(
        deviceIdToHex(root.deviceId),
      );
      expect(verdict.depth).toBe(1);
    }
  });

  it("responds malformed for a request naming a different capability", async () => {
    const holder = await generateEs256Identity();
    const requester = await generateEs256Identity();

    const handler = createBubbleUpCapabilityRequestHandler({
      capability: CAPABILITY,
      identity: holder,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      bearerDevice: requester.deviceId,
      expires: EXPIRES_MS,
      ownToken: () => undefined,
      session: { sendManageRequest: vi.fn() },
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
  });

  it("responds expired for an already-stale ask", async () => {
    const holder = await generateEs256Identity();
    const requester = await generateEs256Identity();

    const handler = createBubbleUpCapabilityRequestHandler({
      capability: CAPABILITY,
      identity: holder,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      bearerDevice: requester.deviceId,
      expires: EXPIRES_MS,
      ownToken: () => undefined,
      session: { sendManageRequest: vi.fn() },
    });

    const incoming = fakeIncoming({
      verb: "capability.request",
      capability: CAPABILITY,
      "valid-until": NOW_MS - 1,
    });
    await handler(incoming);

    expect(incoming.respond).toHaveBeenCalledWith({
      result: "error",
      code: "expired",
    });
  });

  it("forwards to the held token's own issuer and re-delegates the returned grant when its own depth is exhausted", async () => {
    const root = await generateEs256Identity();
    const holder = await generateEs256Identity();
    const requester = await generateEs256Identity();
    const heldToken = await mint(root, holder, { delegationsRemaining: 0 });
    const upstreamGrant = await mint(root, holder, { delegationsRemaining: 1 });

    const sendManageRequest = vi.fn(async (): Promise<ManageOutcome> => ({
      result: "ok",
      "granted-token": upstreamGrant,
    }));
    const handler = createBubbleUpCapabilityRequestHandler({
      capability: CAPABILITY,
      identity: holder,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      bearerDevice: requester.deviceId,
      expires: EXPIRES_MS,
      delegationsRemaining: 0,
      ownToken: () => heldToken,
      session: { sendManageRequest },
    });

    const incoming = fakeIncoming({
      verb: "capability.request",
      capability: CAPABILITY,
    });
    await handler(incoming);

    expect(sendManageRequest).toHaveBeenCalledTimes(1);
    const [, , target] = sendManageRequest.mock.calls[0] as [
      unknown,
      unknown,
      Uint8Array,
    ];
    expect(deviceIdToHex(target)).toBe(deviceIdToHex(root.deviceId));

    const outcome = incoming.respond.mock.calls[0]?.[0] as {
      result: string;
      "granted-token": CapabilityToken;
    };
    expect(outcome.result).toBe("ok");
    const verdict = await verifyCapabilityToken(outcome["granted-token"], {
      identity: holder,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      expectedBearer: requester.deviceId,
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(deviceIdToHex(verdict.rootIssuer)).toBe(
        deviceIdToHex(root.deviceId),
      );
    }
  });

  it("relays the upstream denial unchanged when forwarding is refused", async () => {
    const root = await generateEs256Identity();
    const holder = await generateEs256Identity();
    const requester = await generateEs256Identity();
    const heldToken = await mint(root, holder, { delegationsRemaining: 0 });

    const sendManageRequest = vi.fn(async (): Promise<ManageOutcome> => ({
      result: "error",
      code: "denied",
      message: "no more depth to give",
    }));
    const handler = createBubbleUpCapabilityRequestHandler({
      capability: CAPABILITY,
      identity: holder,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      bearerDevice: requester.deviceId,
      expires: EXPIRES_MS,
      delegationsRemaining: 0,
      ownToken: () => heldToken,
      session: { sendManageRequest },
    });

    const incoming = fakeIncoming({
      verb: "capability.request",
      capability: CAPABILITY,
    });
    await handler(incoming);

    expect(incoming.respond).toHaveBeenCalledWith({
      result: "error",
      code: "denied",
      message: "no more depth to give",
    });
  });

  it("responds denied when this device holds no token and has nothing to forward from", async () => {
    const holder = await generateEs256Identity();
    const requester = await generateEs256Identity();

    const handler = createBubbleUpCapabilityRequestHandler({
      capability: CAPABILITY,
      identity: holder,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      bearerDevice: requester.deviceId,
      expires: EXPIRES_MS,
      ownToken: () => undefined,
      session: { sendManageRequest: vi.fn() },
    });

    const incoming = fakeIncoming({
      verb: "capability.request",
      capability: CAPABILITY,
    });
    await handler(incoming);

    const outcome = incoming.respond.mock.calls[0]?.[0] as {
      result: string;
      code: string;
    };
    expect(outcome.result).toBe("error");
    expect(outcome.code).toBe("denied");
  });
});

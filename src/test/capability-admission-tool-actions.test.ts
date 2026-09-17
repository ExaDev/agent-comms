/**
 * Unit tests for the capability_pending/capability_accept/capability_reject CommsTool actions -- the human-facing wrapper around MeshStore's own createCapabilityAskHandler/listPendingCapabilityRequests/acceptCapabilityRequest/rejectCapabilityRequest (agent-comms#165), mirroring room-admission-tool-actions.test.ts's own real-MeshStore integration style rather than a fully faked harness.
 */

import { webcrypto } from "node:crypto";
import { describe, it, expect } from "vitest";
import type { IncomingManageRequest } from "wire-mesh-core/domain/mesh-session";
import { createNodeIdentity } from "wire-mesh-core/adapters/node-identity";
import { verifyCapabilityToken } from "wire-mesh-core/domain/tokens";
import { createRevocationView } from "wire-mesh-core/domain/revocation-view";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import { MeshStore } from "../core/mesh-store.js";
import { CommsTool } from "../core/tool.js";
import { buildAction } from "../core/bridge.js";
import { toIdentityPort } from "../core/wire-mesh-identity.js";
import { loadOrCreateIdentity } from "../core/identity-store.js";
import { wireTestTransport } from "./test-transport.js";

const ES256 = -7;
const HOUR_MS = 3_600_000;
const CAPABILITY = "dm:send";

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

function fakeCapabilityRequest(): Omit<IncomingManageRequest, "respond"> {
  return {
    requestId: 1,
    command: {
      verb: CAPABILITY,
      params: { verb: "capability.request", capability: CAPABILITY },
    },
    scope: { kind: "user" },
  };
}

describe("capability admission CommsTool actions", () => {
  it("capability_pending lists a held-open capability request", async () => {
    const store = new MeshStore();
    await wireTestTransport(store);
    const owner = await store.registerAgent({
      name: "owner",
      harness: "pi",
      cwd: "/tmp/p",
      pid: process.pid,
      visibility: "visible",
      tags: [],
    });
    const requester = await generateEs256Identity();
    const handler = store.createCapabilityAskHandler({
      capability: CAPABILITY,
      bearerDevice: requester.deviceId,
      timeoutMs: HOUR_MS,
    });
    void handler({
      ...fakeCapabilityRequest(),
      respond: async () => {},
    });

    const tool = new CommsTool(store);
    const ctx = {
      agentId: owner.id,
      harness: "pi",
      cwd: "/tmp/p",
      pid: process.pid,
    };
    const pendingResult = await tool.handle(
      ctx,
      buildAction({ action: "capability_pending" }),
    );

    expect(pendingResult.isError).toBe(false);
    expect(pendingResult.content.includes(CAPABILITY)).toBeTruthy();
  });

  it("capability_accept mints and returns a granted token to the requester", async () => {
    const store = new MeshStore();
    const slot = await wireTestTransport(store);
    const owner = await store.registerAgent({
      name: "owner",
      harness: "pi",
      cwd: "/tmp/p",
      pid: process.pid,
      visibility: "visible",
      tags: [],
    });
    const requester = await generateEs256Identity();
    const handler = store.createCapabilityAskHandler({
      capability: CAPABILITY,
      bearerDevice: requester.deviceId,
      timeoutMs: HOUR_MS,
    });
    let respondedWith: unknown;
    const outcomePromise = handler({
      ...fakeCapabilityRequest(),
      respond: async (outcome) => {
        respondedWith = outcome;
      },
    });

    const tool = new CommsTool(store);
    const ctx = {
      agentId: owner.id,
      harness: "pi",
      cwd: "/tmp/p",
      pid: process.pid,
    };
    const requestId = store.listPendingCapabilityRequests()[0]?.requestId;
    if (requestId === undefined) throw new Error("no pending request found");

    const expires = Date.now() + HOUR_MS;
    const acceptResult = await tool.handle(
      ctx,
      buildAction({
        action: "capability_accept",
        requestId,
        expires,
      }),
    );

    expect(acceptResult.isError).toBe(false);
    await outcomePromise;
    const outcome = respondedWith as {
      result: string;
      "granted-token": Parameters<typeof verifyCapabilityToken>[0];
    };
    expect(outcome.result).toBe("ok");

    const identity = await toIdentityPort(loadOrCreateIdentity(slot));
    const verdict = await verifyCapabilityToken(outcome["granted-token"], {
      identity,
      clock: { now: () => Date.now() },
      revocation: createRevocationView(),
      expectedBearer: requester.deviceId,
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.claims.capability).toBe(CAPABILITY);
    }

    const pendingAfter = await tool.handle(
      ctx,
      buildAction({ action: "capability_pending" }),
    );
    expect(pendingAfter.content).toBe("No pending capability requests.");
  });

  it("capability_reject denies the pending request with an optional reason", async () => {
    const store = new MeshStore();
    await wireTestTransport(store);
    const owner = await store.registerAgent({
      name: "owner",
      harness: "pi",
      cwd: "/tmp/p",
      pid: process.pid,
      visibility: "visible",
      tags: [],
    });
    const requester = await generateEs256Identity();
    const handler = store.createCapabilityAskHandler({
      capability: CAPABILITY,
      bearerDevice: requester.deviceId,
      timeoutMs: HOUR_MS,
    });
    let respondedWith: unknown;
    const outcomePromise = handler({
      ...fakeCapabilityRequest(),
      respond: async (outcome) => {
        respondedWith = outcome;
      },
    });

    const tool = new CommsTool(store);
    const ctx = {
      agentId: owner.id,
      harness: "pi",
      cwd: "/tmp/p",
      pid: process.pid,
    };
    const pendingList = store.listPendingCapabilityRequests();
    const requestId = pendingList[0]?.requestId;
    if (requestId === undefined) throw new Error("no pending request found");

    const rejectResult = await tool.handle(
      ctx,
      buildAction({
        action: "capability_reject",
        requestId,
        reason: "not now",
      }),
    );

    expect(rejectResult.isError).toBe(false);
    await outcomePromise;
    expect(respondedWith).toEqual({
      result: "error",
      code: "denied",
      message: "not now",
    });
  });

  it("capability_accept on a store with no matching pending request reports failure, not a crash", async () => {
    const store = new MeshStore();
    await wireTestTransport(store);
    const owner = await store.registerAgent({
      name: "owner",
      harness: "pi",
      cwd: "/tmp/p",
      pid: process.pid,
      visibility: "visible",
      tags: [],
    });
    const tool = new CommsTool(store);
    const ctx = {
      agentId: owner.id,
      harness: "pi",
      cwd: "/tmp/p",
      pid: process.pid,
    };

    const result = await tool.handle(
      ctx,
      buildAction({
        action: "capability_accept",
        requestId: "not-a-real-request",
        expires: Date.now() + HOUR_MS,
      }),
    );

    expect(result.isError).toBe(true);
  });
});

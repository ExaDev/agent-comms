/**
 * A capability request that wire-mesh-core's timeout has already answered is no longer pending, so a later accept or reject reports it as not found instead of reporting success for a request nobody is waiting on.
 */
import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNodeIdentity } from "wire-mesh-core/adapters/node-identity";
import type { IncomingManageRequest } from "wire-mesh-core/domain/mesh-session";
import type { Clock } from "wire-mesh-core/ports/clock";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import { CapabilityAskAdmission } from "../core/capability-ask.js";

const ES256 = -7;
const NOW_MS = 1_893_456_000_000;
const WINDOW_MS = 60_000;
const CAPABILITY = "dm:send";

async function es256Identity(): Promise<IdentityPort> {
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

async function askHeld() {
  const admission = new CapabilityAskAdmission({
    getPeerId: () => "owner-peer",
    getOnDelivery: () => undefined,
    queueDelivery: () => undefined,
  });
  const clock: Clock = { now: () => NOW_MS };
  const handler = admission.createAskHandler({
    capability: CAPABILITY,
    identity: await es256Identity(),
    clock,
    bearerDevice: (await es256Identity()).deviceId,
    timeoutMs: WINDOW_MS,
  });
  const respond = vi.fn(async () => undefined);
  const incoming: IncomingManageRequest & { respond: typeof respond } = {
    requestId: 1,
    command: {
      verb: CAPABILITY,
      params: { verb: "capability.request", capability: CAPABILITY },
    },
    scope: { kind: "user" },
    respond,
  };
  await handler(incoming);
  const [pending] = admission.listPendingCapabilityRequests();
  if (pending === undefined) throw new Error("the ask was not held open");
  return { admission, respond, requestId: pending.requestId };
}

describe("a capability request after its window has passed", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is dropped from the pending set, and accepting it reports it as not found", async () => {
    vi.useFakeTimers();
    const { admission, respond, requestId } = await askHeld();

    await vi.advanceTimersByTimeAsync(WINDOW_MS);

    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({ code: "timeout" }),
    );
    expect(admission.listPendingCapabilityRequests()).toEqual([]);
    await expect(
      admission.acceptCapabilityRequest(requestId, { expires: NOW_MS }),
    ).rejects.toMatchObject({ code: "NOT_PENDING" });
    await expect(
      admission.rejectCapabilityRequest(requestId),
    ).rejects.toMatchObject({ code: "NOT_PENDING" });
  });

  it("is still pending just before the window ends", async () => {
    vi.useFakeTimers();
    const { admission } = await askHeld();

    await vi.advanceTimersByTimeAsync(WINDOW_MS - 1);

    expect(admission.listPendingCapabilityRequests()).toHaveLength(1);
  });
});

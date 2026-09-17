/**
 * Direct unit tests for bind-retry.ts's retryOnAddrInUse helper (agent-comms#170): WireMeshTransport.becomeCoordinator's own bind-retry safety net for the graceful coordinator handover race. When the outgoing coordinator sends become_coordinator and the successor's own handleBecomeCoordinator tries to rebind the coordinator port moments later, the outgoing side's listening socket may not have finished releasing that port yet -- an ordinary EADDRINUSE, not a design flaw, but one that would otherwise surface as an unhandled rejection crashing the process (onBecomeCoordinator's own dispatch in mesh-store.ts is fire-and-forget). retryOnAddrInUse is deliberately a pure, transport-agnostic helper (no real sockets) so this race's retry/backoff logic is fast and deterministic to test directly, independent of wire-mesh-transport's own real-TLS-socket test suite.
 */
import { describe, expect, it, vi } from "vitest";
import { retryOnAddrInUse } from "../core/bind-retry.js";

const RETRIES = 3;
const DELAY_MS = 10;

function addrInUseError(): Error {
  return new Error("listen EADDRINUSE: address already in use 127.0.0.1:1");
}

describe("retryOnAddrInUse", () => {
  it("returns the result immediately when the first attempt succeeds", async () => {
    const attempt = vi.fn().mockResolvedValue("bound");

    const result = await retryOnAddrInUse(attempt, RETRIES, DELAY_MS);

    expect(result).toBe("bound");
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("retries on an EADDRINUSE-shaped rejection and returns once a later attempt succeeds", async () => {
    const failuresBeforeSuccess = 2;
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(addrInUseError())
      .mockRejectedValueOnce(addrInUseError())
      .mockResolvedValue("bound");

    const result = await retryOnAddrInUse(attempt, RETRIES, DELAY_MS);

    expect(result).toBe("bound");
    expect(attempt).toHaveBeenCalledTimes(failuresBeforeSuccess + 1);
  });

  it("rethrows immediately for a rejection that isn't EADDRINUSE, without retrying", async () => {
    const otherError = new Error("listen EACCES: permission denied");
    const attempt = vi.fn().mockRejectedValue(otherError);

    await expect(retryOnAddrInUse(attempt, RETRIES, DELAY_MS)).rejects.toBe(
      otherError,
    );
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("rethrows the last EADDRINUSE error once the retry budget is exhausted", async () => {
    const attempt = vi.fn().mockRejectedValue(addrInUseError());

    await expect(retryOnAddrInUse(attempt, RETRIES, DELAY_MS)).rejects.toThrow(
      "EADDRINUSE",
    );
    // The initial attempt plus exactly `retries` further attempts, never one more.
    expect(attempt).toHaveBeenCalledTimes(RETRIES + 1);
  });
});

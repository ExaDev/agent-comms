/**
 * Direct unit tests for SharedPeer -- the lazily-created, process-wide holder of a cc-peer peer, exercised against a fake factory so no real socket is opened.
 */
import { describe, expect, it, vi } from "vitest";
import { SharedPeer } from "../bridges/cc-peer/shared-peer.js";

describe("SharedPeer", () => {
  it("does not create the peer until it is first asked for", () => {
    const create = vi.fn(async () => Promise.resolve("peer"));
    new SharedPeer(create);
    expect(create).not.toHaveBeenCalled();
  });

  it("creates the peer once and hands every caller the same instance, including concurrent callers", async () => {
    const create = vi.fn(async () => Promise.resolve({ id: 1 }));
    const shared = new SharedPeer(create);

    const [a, b] = await Promise.all([shared.get(), shared.get()]);
    const c = await shared.get();

    expect(create).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it("retries creation on the next request after a failed attempt instead of caching the rejection", async () => {
    const create = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("listen EADDRINUSE"))
      .mockResolvedValue("peer");
    const shared = new SharedPeer(create);

    await expect(shared.get()).rejects.toThrow("listen EADDRINUSE");
    await expect(shared.get()).resolves.toBe("peer");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("release() returns the created peer and forgets it, so a later get() creates a fresh one", async () => {
    const create = vi
      .fn<() => Promise<{ id: number }>>()
      .mockResolvedValueOnce({ id: 1 })
      .mockResolvedValueOnce({ id: 2 });
    const shared = new SharedPeer(create);

    const first = await shared.get();
    expect(await shared.release()).toBe(first);
    expect(await shared.get()).toEqual({ id: 2 });
  });

  it("release() returns undefined when no peer was ever created, or the creation failed", async () => {
    const shared = new SharedPeer(async () =>
      Promise.reject(new Error("boom")),
    );
    expect(await shared.release()).toBeUndefined();

    await expect(shared.get()).rejects.toThrow("boom");
    expect(await shared.release()).toBeUndefined();
  });
});

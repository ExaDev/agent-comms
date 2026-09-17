/**
 * Unit tests for wireDefaultCcPeerFront -- builds the store.onCoordinatorRoleChanged callback a real bridge assigns to its own store, tested with an injected fake front-builder rather than a real CcPeer/MeshStore.
 */
import { describe, expect, it, vi } from "vitest";
import { wireDefaultCcPeerFront } from "../bridges/cc-peer/default-front.js";
import type { WireDefaultCcPeerFrontOptions } from "../bridges/cc-peer/default-front.js";
import type { MeshStore } from "../core/mesh-store.js";

function fakeStore(): Pick<MeshStore, "onError"> {
  return { onError: undefined };
}

function fakeFront(): {
  start: ReturnType<typeof vi.fn<() => void>>;
  stop: ReturnType<typeof vi.fn<() => Promise<void>>>;
} {
  return {
    start: vi.fn<() => void>(),
    stop: vi.fn<() => Promise<void>>(async () => Promise.resolve()),
  };
}

describe("wireDefaultCcPeerFront", () => {
  it("starts the front when told the store became coordinator", async () => {
    const front = fakeFront();
    const onRoleChanged = wireDefaultCcPeerFront(fakeStore(), {
      createFront: () => front,
    });

    await onRoleChanged(true);

    expect(front.start).toHaveBeenCalledTimes(1);
    expect(front.stop).not.toHaveBeenCalled();
  });

  it("stops the front when told the store lost the coordinator role", async () => {
    const front = fakeFront();
    const onRoleChanged = wireDefaultCcPeerFront(fakeStore(), {
      createFront: () => front,
    });

    await onRoleChanged(false);

    expect(front.stop).toHaveBeenCalledTimes(1);
    expect(front.start).not.toHaveBeenCalled();
  });

  it("builds the front once, up front, not on every role change", async () => {
    const createFront = vi.fn(() => fakeFront());
    const onRoleChanged = wireDefaultCcPeerFront(fakeStore(), { createFront });

    await onRoleChanged(true);
    await onRoleChanged(false);
    await onRoleChanged(true);

    expect(createFront).toHaveBeenCalledTimes(1);
  });

  it("passes coordinatorPort and hubUrl through to the front builder", () => {
    const createFront = vi.fn(() => fakeFront());
    const options: WireDefaultCcPeerFrontOptions = {
      coordinatorPort: 20123,
      hubUrl: "wss://example.test/hub",
      createFront,
    };
    wireDefaultCcPeerFront(fakeStore(), options);

    expect(createFront).toHaveBeenCalledWith(
      expect.objectContaining({
        coordinatorPort: 20123,
        hubUrl: "wss://example.test/hub",
      }),
    );
  });

  it("forwards a front error to the store's own onError, when one is set", () => {
    const store = fakeStore();
    const onError = vi.fn<(error: Error) => void>();
    store.onError = onError;
    let capturedOnError: ((error: Error) => void) | undefined;
    wireDefaultCcPeerFront(store, {
      createFront: (opts) => {
        capturedOnError = opts.onError;
        return fakeFront();
      },
    });

    const error = new Error("cc-peer roster unavailable");
    capturedOnError?.(error);

    expect(onError).toHaveBeenCalledWith(error);
  });
});

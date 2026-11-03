/**
 * Unit tests for the mesh store createDefaultCcPeerFront builds for each fronted session (agent-comms#476): it is built with no first-contact presence of its own, since every fronted store lives in the coordinator's process beside that process's own store and joins the mesh through it. A presence per fronted store put one more socket on the shared beacon port for every fronted session, each answering every probe on the machine. Mesh construction and the front's identity load are replaced by fakes, so no real store, identity file or socket is created.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultCcPeerFront,
  type FrontCcPeer,
} from "../bridges/cc-peer/front-runtime.js";
import type { CcPeerRosterEntryLike } from "../bridges/cc-peer/front.js";
import type * as core from "../core/index.js";
import type * as identityStore from "../core/identity-store.js";

const { createBridgeMeshFromIdentity, frontIdentity } = vi.hoisted(() => ({
  createBridgeMeshFromIdentity: vi.fn(),
  frontIdentity: { deviceId: [] },
}));

vi.mock("../core/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof core>()),
  createBridgeMeshFromIdentity,
}));

vi.mock("../core/identity-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof identityStore>()),
  loadIdentityForFront: () => frontIdentity,
  probeSlotOwner: () => undefined,
}));

const POLL_INTERVAL_MS = 1000;

const SESSION: CcPeerRosterEntryLike = {
  pid: 4343,
  cwd: "/tmp/front-runtime-mesh-unit-test",
  version: "2.1.278",
  messagingSocketPath: "/tmp/cc-socks/4343.sock",
};

function borrowedPeer(): FrontCcPeer {
  return {
    roster: async () => Promise.resolve([SESSION]),
    on: vi.fn<FrontCcPeer["on"]>(),
    send: async () => Promise.resolve({ msgId: "m" }),
    stop: async () => Promise.resolve(),
  };
}

describe("createDefaultCcPeerFront's per-session mesh store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // The test needs only the arguments the store was built with, so construction stops there; the front reports the rejection through onError and retries on a later tick.
    createBridgeMeshFromIdentity.mockRejectedValue(
      new Error("mesh construction stubbed out"),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    createBridgeMeshFromIdentity.mockReset();
  });

  it("is built with no first-contact presence of its own", async () => {
    const onError = vi.fn<(error: Error) => void>();
    const front = createDefaultCcPeerFront({
      peer: borrowedPeer(),
      pollIntervalMs: POLL_INTERVAL_MS,
      onError,
    });

    front.start();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await front.stop();

    expect(createBridgeMeshFromIdentity).toHaveBeenCalledWith(
      frontIdentity,
      { harness: "claude-code", cwd: SESSION.cwd },
      expect.objectContaining({ firstContactPort: false }),
    );
  });
});

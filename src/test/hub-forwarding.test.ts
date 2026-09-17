/**
 * Direct unit tests for forwardAdvertsToHub/pushHubCatchUp's own gateway-trust gate (agent-comms#156) -- previously only exercised indirectly through gateway-forwarding.integration.test.ts's real-hub harness. Uses a fake hub object (isConnected/advertiseDevices) rather than a real HubSession, mirroring gossip-directory.test.ts's own standalone-fixture approach for the sibling gossip-merge function.
 */
import { describe, expect, it, vi } from "vitest";
import { forwardAdvertsToHub, pushHubCatchUp } from "../core/hub-forwarding.js";
import type { DirectoryEntry } from "wire-mesh-core/domain/mesh-session";
import type { PeerAdvert } from "wire-mesh-core/generated/protocol";

const DEVICE_ID_HEX_LENGTH = 64;
const DEVICE_A_HEX = "a".repeat(DEVICE_ID_HEX_LENGTH);

function deviceIdBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function advert(): PeerAdvert {
  return { addresses: [], "snapshot-seconds": 1 } as unknown as PeerAdvert;
}

function entry(hex: string): DirectoryEntry {
  return {
    device: deviceIdBytes(hex),
    advert: { ...advert(), "agent/self": {} },
  };
}

function fakeHub(): {
  isConnected: boolean;
  advertiseDevices: ReturnType<
    typeof vi.fn<(entries: readonly DirectoryEntry[]) => Promise<void>>
  >;
} {
  return {
    isConnected: true,
    advertiseDevices: vi.fn().mockResolvedValue(undefined),
  };
}

describe("forwardAdvertsToHub -- gateway-trust gate", () => {
  it("does not advertise anything when no remote gateway is trusted", () => {
    const hub = fakeHub();

    forwardAdvertsToHub(hub, [entry(DEVICE_A_HEX)], undefined, () => false);

    expect(hub.advertiseDevices).not.toHaveBeenCalled();
  });

  it("advertises once at least one remote gateway is trusted", () => {
    const hub = fakeHub();

    forwardAdvertsToHub(hub, [entry(DEVICE_A_HEX)], undefined, () => true);

    expect(hub.advertiseDevices).toHaveBeenCalledTimes(1);
  });

  it("still does nothing when not connected, even when trusted", () => {
    const hub = fakeHub();
    hub.isConnected = false;

    forwardAdvertsToHub(hub, [entry(DEVICE_A_HEX)], undefined, () => true);

    expect(hub.advertiseDevices).not.toHaveBeenCalled();
  });
});

describe("pushHubCatchUp -- gateway-trust gate", () => {
  it("does not push the catch-up when no remote gateway is trusted", () => {
    const hub = fakeHub();
    const knownDevices = new Map([[DEVICE_A_HEX, entry(DEVICE_A_HEX).advert]]);

    pushHubCatchUp(hub, knownDevices, undefined, () => false);

    expect(hub.advertiseDevices).not.toHaveBeenCalled();
  });

  it("pushes the catch-up once at least one remote gateway is trusted", () => {
    const hub = fakeHub();
    const knownDevices = new Map([[DEVICE_A_HEX, entry(DEVICE_A_HEX).advert]]);

    pushHubCatchUp(hub, knownDevices, undefined, () => true);

    expect(hub.advertiseDevices).toHaveBeenCalledTimes(1);
  });
});

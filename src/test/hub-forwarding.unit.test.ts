/**
 * Direct unit tests for forwardAdvertsToHub/pushHubCatchUp's own gateway-trust gate (agent-comms#156) -- previously only exercised indirectly through gateway-forwarding.integration.test.ts's real-hub harness. Uses a fake hub object (isConnected/advertiseDevices) rather than a real HubSession, mirroring gossip-directory.test.ts's own standalone-fixture approach for the sibling gossip-merge function.
 */
import { describe, expect, it, vi } from "vitest";
import {
  forwardAdvertsToHub,
  makeSendToLocalPeer,
  pushHubCatchUp,
} from "../core/hub-forwarding.js";
import type {
  DirectoryEntry,
  ManageOutcome,
} from "wire-mesh-core/domain/mesh-session";
import type {
  CapabilityScope,
  ManageCommand,
} from "wire-mesh-core/generated/protocol";
import { syntheticAdvert } from "./synthetic-advert.js";

const DEVICE_ID_HEX_LENGTH = 64;
const DEVICE_A_HEX = "a".repeat(DEVICE_ID_HEX_LENGTH);
const DEVICE_B_HEX = "b".repeat(DEVICE_ID_HEX_LENGTH);

function deviceIdBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function entry(hex: string): DirectoryEntry {
  const device = deviceIdBytes(hex);
  return {
    device,
    advert: syntheticAdvert(device, {
      snapshotSeconds: 1,
      extensions: { "agent/self": {} },
    }),
  };
}

function fakeHub(peers: readonly string[] = []): {
  isConnected: boolean;
  peers: () => readonly string[];
  advertiseDevices: ReturnType<
    typeof vi.fn<(entries: readonly DirectoryEntry[]) => Promise<void>>
  >;
} {
  return {
    isConnected: true,
    peers: () => peers,
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

describe("pushHubCatchUp -- devices learned from the hub", () => {
  it("advertises only the devices this side fronts, never one it learned from the hub", () => {
    const hub = fakeHub([DEVICE_B_HEX]);
    const knownDevices = new Map([
      [DEVICE_A_HEX, entry(DEVICE_A_HEX).advert],
      [DEVICE_B_HEX, entry(DEVICE_B_HEX).advert],
    ]);

    pushHubCatchUp(hub, knownDevices, undefined, () => true);

    const advertised = hub.advertiseDevices.mock.calls.flatMap(([entries]) =>
      entries.map((forwarded) => forwarded.advert.device),
    );
    expect(advertised).toEqual([entry(DEVICE_A_HEX).advert.device]);
  });

  it("advertises nothing when every known device was learned from the hub", () => {
    const hub = fakeHub([DEVICE_A_HEX]);
    const knownDevices = new Map([[DEVICE_A_HEX, entry(DEVICE_A_HEX).advert]]);

    pushHubCatchUp(hub, knownDevices, undefined, () => true);

    expect(hub.advertiseDevices).not.toHaveBeenCalled();
  });
});

describe("makeSendToLocalPeer -- synchronous no-session signal", () => {
  const command: ManageCommand = { verb: "room:member", params: {} };
  const scope: Readonly<CapabilityScope> = { kind: "room", path: "owner/room" };

  it("returns undefined synchronously, never a Promise, when no local session exists for the device", () => {
    const send = makeSendToLocalPeer(new Map());

    const result = send(DEVICE_A_HEX, command, scope, undefined);

    // HubSession branches on `forwarded !== undefined` to decide whether to fall back to local dispatch, so the no-session signal has to be a plain undefined: an async wrapper would return a Promise here (always defined) and silently disable that fallback for every device this gateway doesn't front.
    expect(result).toBeUndefined();
  });

  it("forwards to the local session and returns its own outcome when one exists", async () => {
    const outcome: ManageOutcome = { result: "error", code: "not_connected" };
    const sendManageRequest = vi.fn().mockResolvedValue(outcome);
    const send = makeSendToLocalPeer(
      new Map([[DEVICE_A_HEX, { sendManageRequest }]]),
    );

    const result = send(DEVICE_A_HEX, command, scope, undefined);

    await expect(result).resolves.toBe(outcome);
    expect(sendManageRequest).toHaveBeenCalledWith(
      command,
      scope,
      undefined,
      undefined,
    );
  });
});

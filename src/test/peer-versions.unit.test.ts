/**
 * Unit tests for peer-versions.ts's read side (agent-comms#198): extracting a specific device's gossiped wire-mesh-core/agent-comms/cc-peer versions back out of a fake listKnownDevices, without any real mesh machinery.
 */

import { describe, it, expect } from "vitest";
import {
  getPeerAgentCommsVersions,
  getPeerWireMeshCoreVersion,
} from "../core/peer-versions.js";
import type { MeshTransport } from "../core/transport.js";

function fakeTransport(
  devices: readonly { deviceId: string; advert: Record<string, unknown> }[],
): Pick<MeshTransport, "listKnownDevices"> {
  return { listKnownDevices: () => devices };
}

describe("getPeerWireMeshCoreVersion", () => {
  it("returns undefined when the transport has no listKnownDevices capability", () => {
    expect(getPeerWireMeshCoreVersion({}, "device-1")).toBeUndefined();
  });

  it("returns undefined for a device this side has never heard gossip from", () => {
    const transport = fakeTransport([
      { deviceId: "other-device", advert: { "wire-mesh/version": "1.0.0" } },
    ]);
    expect(getPeerWireMeshCoreVersion(transport, "device-1")).toBeUndefined();
  });

  it("returns the gossiped version string when present", () => {
    const transport = fakeTransport([
      { deviceId: "device-1", advert: { "wire-mesh/version": "1.50.0" } },
    ]);
    expect(getPeerWireMeshCoreVersion(transport, "device-1")).toBe("1.50.0");
  });

  it("returns undefined when the gossiped value isn't a string", () => {
    const transport = fakeTransport([
      { deviceId: "device-1", advert: { "wire-mesh/version": 42 } },
    ]);
    expect(getPeerWireMeshCoreVersion(transport, "device-1")).toBeUndefined();
  });
});

describe("getPeerAgentCommsVersions", () => {
  it("returns undefined for a malformed advert (missing agentComms)", () => {
    const transport = fakeTransport([
      {
        deviceId: "device-1",
        advert: { "agent-comms/version": { ccPeer: "1.0.0" } },
      },
    ]);
    expect(getPeerAgentCommsVersions(transport, "device-1")).toBeUndefined();
  });

  it("returns the parsed advert, ccPeer included, when well-formed", () => {
    const transport = fakeTransport([
      {
        deviceId: "device-1",
        advert: {
          "agent-comms/version": { agentComms: "3.0.0", ccPeer: "1.5.0" },
        },
      },
    ]);
    expect(getPeerAgentCommsVersions(transport, "device-1")).toEqual({
      agentComms: "3.0.0",
      ccPeer: "1.5.0",
    });
  });

  it("returns the parsed advert with no ccPeer field when the device isn't fronting/bridging one", () => {
    const transport = fakeTransport([
      {
        deviceId: "device-1",
        advert: { "agent-comms/version": { agentComms: "3.0.0" } },
      },
    ]);
    expect(getPeerAgentCommsVersions(transport, "device-1")).toEqual({
      agentComms: "3.0.0",
    });
  });
});

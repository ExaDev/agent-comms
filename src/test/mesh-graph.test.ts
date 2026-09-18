/**
 * Unit tests for computeMeshGraph (agent-comms#199/#201) and handlePathTraceRequest (agent-comms#199/#216).
 */

import { describe, expect, it } from "vitest";
import {
  deviceIdFromHex,
  deviceIdToHex,
} from "wire-mesh-core/domain/device-id";
import type {
  IncomingManageRequest,
  ManageOutcome,
} from "wire-mesh-core/domain/mesh-session";
import type { PeerAdvert } from "wire-mesh-core/generated/protocol";
import {
  computeMeshGraph,
  handlePathTraceRequest,
} from "../core/mesh-graph.js";
import type { ConnectionHandle } from "../core/transport.js";

/** A device-id is a hex-encoded SHA-256 hash: 32 bytes, 64 hex characters. */
const DEVICE_ID_HEX_LENGTH = 64;
const DEVICE_A_HEX = "a".repeat(DEVICE_ID_HEX_LENGTH);
const DEVICE_B_HEX = "b".repeat(DEVICE_ID_HEX_LENGTH);
const DEVICE_C_HEX = "c".repeat(DEVICE_ID_HEX_LENGTH);

const TOPOLOGY_PEERS_GOSSIP_KEY = "topology/peers";

function advertFor(
  deviceHex: string,
  topology?: {
    direct?: string[];
    relayed?: { device: string; via?: string }[];
  },
): PeerAdvert {
  return {
    device: deviceIdFromHex(deviceHex),
    addresses: [],
    "snapshot-seconds": 0,
    ...(topology !== undefined
      ? {
          [TOPOLOGY_PEERS_GOSSIP_KEY]: {
            direct: (topology.direct ?? []).map(deviceIdFromHex),
            relayed: (topology.relayed ?? []).map((r) => ({
              device: deviceIdFromHex(r.device),
              ...(r.via !== undefined ? { via: deviceIdFromHex(r.via) } : {}),
            })),
          },
        }
      : {}),
  };
}

describe("computeMeshGraph", () => {
  it("returns an empty graph for no known devices", () => {
    expect(computeMeshGraph(new Map())).toEqual({ nodes: [], edges: [] });
  });

  it("includes a direct edge's endpoint in nodes even without its own directory entry", () => {
    // A's own directory entry self-reports a direct connection to B, but this side has never itself gossiped with B directly -- no directory entry for B exists. assembleTopologyGraph's own nodes list would omit B (it's only built from directory entries), which previously made the graph malformed for any consumer expecting every edge endpoint to also be a node (confirmed live: d3-force's forceLink threw "node not found" rendering exactly this shape).
    const knownDevices = new Map([
      [DEVICE_A_HEX, advertFor(DEVICE_A_HEX, { direct: [DEVICE_B_HEX] })],
    ]);

    const graph = computeMeshGraph(knownDevices);

    expect(graph.nodes).toContain(DEVICE_A_HEX);
    expect(graph.nodes).toContain(DEVICE_B_HEX);
    expect(graph.edges).toEqual([
      { kind: "direct", from: DEVICE_A_HEX, to: DEVICE_B_HEX },
    ]);
  });

  it("includes a relay edge's device and via endpoints in nodes without their own directory entries", () => {
    const knownDevices = new Map([
      [
        DEVICE_A_HEX,
        advertFor(DEVICE_A_HEX, {
          relayed: [{ device: DEVICE_B_HEX, via: DEVICE_C_HEX }],
        }),
      ],
    ]);

    const graph = computeMeshGraph(knownDevices);

    expect(graph.nodes).toContain(DEVICE_A_HEX);
    expect(graph.nodes).toContain(DEVICE_B_HEX);
    expect(graph.nodes).toContain(DEVICE_C_HEX);
    expect(graph.edges).toEqual([
      {
        kind: "relay",
        from: DEVICE_A_HEX,
        to: DEVICE_B_HEX,
        via: DEVICE_C_HEX,
      },
    ]);
  });

  it("never duplicates a node already present from its own directory entry", () => {
    const knownDevices = new Map([
      [DEVICE_A_HEX, advertFor(DEVICE_A_HEX, { direct: [DEVICE_B_HEX] })],
      [DEVICE_B_HEX, advertFor(DEVICE_B_HEX)],
    ]);

    const graph = computeMeshGraph(knownDevices);

    expect(graph.nodes.filter((id) => id === DEVICE_B_HEX)).toHaveLength(1);
  });

  it("reports every node as a real hex-encoded device-id, matching deviceIdToHex", () => {
    const knownDevices = new Map([
      [DEVICE_A_HEX, advertFor(DEVICE_A_HEX, { direct: [DEVICE_B_HEX] })],
    ]);

    const graph = computeMeshGraph(knownDevices);

    for (const node of graph.nodes) {
      expect(deviceIdToHex(deviceIdFromHex(node))).toBe(node);
    }
  });
});

const TEST_HANDLE: ConnectionHandle = { id: DEVICE_A_HEX };

function fakeIncomingRequest(
  fromDeviceHex?: string,
): Readonly<IncomingManageRequest> {
  return {
    requestId: 1,
    command: { verb: "path:trace", params: {} },
    scope: { kind: "room" },
    ...(fromDeviceHex !== undefined
      ? { fromDevice: deviceIdFromHex(fromDeviceHex) }
      : {}),
    respond: async (): Promise<void> => undefined,
  };
}

describe("handlePathTraceRequest", () => {
  it("reports relayHubAddress from origin as the response's own hub-address extension, for a relayed request", async () => {
    const outcome = await handlePathTraceRequest(
      fakeIncomingRequest(DEVICE_B_HEX),
      TEST_HANDLE,
      { relayHubAddress: "wss://hub.example/" },
    );

    expect(outcome).toEqual({
      result: "ok",
      relayed: true,
      "hub-address": "wss://hub.example/",
    });
  });

  it("omits hub-address when origin carries no relayHubAddress, even for a relayed request", async () => {
    const outcome: ManageOutcome = await handlePathTraceRequest(
      fakeIncomingRequest(DEVICE_B_HEX),
      TEST_HANDLE,
      {},
    );

    expect(outcome).toEqual({ result: "ok", relayed: true });
  });

  it("omits hub-address when the caller supplies no origin at all", async () => {
    const outcome = await handlePathTraceRequest(
      fakeIncomingRequest(DEVICE_B_HEX),
      TEST_HANDLE,
    );

    expect(outcome).toEqual({ result: "ok", relayed: true });
  });

  it("omits hub-address for a direct (non-relayed) request even when origin carries relayHubAddress", async () => {
    const outcome = await handlePathTraceRequest(
      fakeIncomingRequest(),
      TEST_HANDLE,
      { relayHubAddress: "wss://hub.example/" },
    );

    expect(outcome).toEqual({ result: "ok", relayed: false });
  });
});

/**
 * Unit tests for version-report-actions.ts's pure formatting/action helpers (agent-comms#198) -- exercised directly against fake stores rather than a real MeshStore, mirroring gateway-trust-actions.ts's own test style for the same reason: every one of these is a pure translation from whatever the store answers into either a CommsResult or a formatted line, with no mesh machinery of its own to set up.
 */

import { describe, it, expect } from "vitest";
import {
  formatListedAgentVersions,
  formatSelfVersionLines,
  formatSelfVersionSuffix,
  handleQueryVersion,
  type VersionReportStore,
} from "../core/version-report-actions.js";
import { getOwnPackageVersion } from "../core/package-version.js";
import { getWireMeshCoreVersion } from "../core/wire-mesh-core-version.js";

describe("handleQueryVersion", () => {
  it("reports not-mesh-backed when the store has no queryVersion method", async () => {
    const result = await handleQueryVersion(
      {},
      { action: "query_version", device: "abc123" },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("requires a mesh-backed store");
  });

  it("reports the peer's live version on success", async () => {
    const store: VersionReportStore = {
      queryVersion: async (deviceId) => {
        await Promise.resolve();
        expect(deviceId).toBe("abc123");
        return { version: "1.2.3" };
      },
    };
    const result = await handleQueryVersion(store, {
      action: "query_version",
      device: "abc123",
    });
    expect(result.isError).toBe(false);
    expect(result.content).toBe("abc123 is running wire-mesh-core 1.2.3.");
  });

  it("reports the store's own error on failure", async () => {
    const store: VersionReportStore = {
      queryVersion: async () => {
        await Promise.resolve();
        return { error: "unauthorized" };
      },
    };
    const result = await handleQueryVersion(store, {
      action: "query_version",
      device: "abc123",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toBe(
      "Failed to query abc123's version: unauthorized",
    );
  });
});

describe("formatSelfVersionLines / formatSelfVersionSuffix", () => {
  it("includes only the wire-mesh-core line when no cc-peer getter is wired", () => {
    expect(formatSelfVersionLines(undefined)).toEqual([
      `Wire-mesh-core: ${getWireMeshCoreVersion()}`,
    ]);
    expect(formatSelfVersionSuffix(undefined)).toBe(
      `, wireMeshCore=${getWireMeshCoreVersion()}`,
    );
  });

  it("includes a cc-peer line/suffix once a getter answers one", () => {
    const getCcPeerVersion = () => "9.9.9";
    expect(formatSelfVersionLines(getCcPeerVersion)).toEqual([
      `Wire-mesh-core: ${getWireMeshCoreVersion()}`,
      "Cc-peer: 9.9.9",
    ]);
    expect(formatSelfVersionSuffix(getCcPeerVersion)).toBe(
      `, wireMeshCore=${getWireMeshCoreVersion()}, ccPeer=9.9.9`,
    );
  });
});

describe("formatListedAgentVersions", () => {
  it("reads local versions for the requester's own entry, ignoring the store's peer getters", () => {
    const store: VersionReportStore = {
      getPeerAgentCommsVersion: () => "should-not-be-used",
      getPeerWireMeshCoreVersion: () => "should-not-be-used",
      getPeerCcPeerVersion: () => "should-not-be-used",
    };
    const formatted = formatListedAgentVersions(
      store,
      "self-device",
      true,
      () => "9.9.9",
    );
    expect(formatted).toBe(
      `agent-comms ${getOwnPackageVersion()}, wire-mesh-core ${getWireMeshCoreVersion()}, cc-peer 9.9.9`,
    );
  });

  it("reads gossiped versions for another peer, defaulting to unknown when never gossiped", () => {
    const knownPeer = formatListedAgentVersions(
      {
        getPeerAgentCommsVersion: () => "3.0.0",
        getPeerWireMeshCoreVersion: () => "1.50.0",
      },
      "peer-device",
      false,
      undefined,
    );
    expect(knownPeer).toBe("agent-comms 3.0.0, wire-mesh-core 1.50.0");

    const unknownPeer = formatListedAgentVersions(
      {},
      "peer-device",
      false,
      undefined,
    );
    expect(unknownPeer).toBe("agent-comms unknown, wire-mesh-core unknown");
  });

  it("includes a peer's cc-peer version only when the store actually reports one", () => {
    const formatted = formatListedAgentVersions(
      {
        getPeerAgentCommsVersion: () => "3.0.0",
        getPeerWireMeshCoreVersion: () => "1.50.0",
        getPeerCcPeerVersion: () => "1.5.0",
      },
      "peer-device",
      false,
      undefined,
    );
    expect(formatted).toBe(
      "agent-comms 3.0.0, wire-mesh-core 1.50.0, cc-peer 1.5.0",
    );
  });
});

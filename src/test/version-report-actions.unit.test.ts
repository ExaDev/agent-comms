/**
 * Unit tests for version-report-actions.ts's formatting helpers that read this process's own versions (agent-comms#198). The helpers that depend only on what a store answers are in the conformance corpus (conformance/function/version-report-actions.json); these stay because their expected text names the running package's and dependency's own version, which a language-neutral case cannot pin.
 */

import { describe, it, expect } from "vitest";
import {
  formatListedAgentVersions,
  formatSelfVersionLines,
  formatSelfVersionSuffix,
  type VersionReportStore,
} from "../core/version-report-actions.js";
import { getOwnPackageVersion } from "../core/package-version.js";
import { getWireMeshCoreVersion } from "../core/wire-mesh-core-version.js";

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
});

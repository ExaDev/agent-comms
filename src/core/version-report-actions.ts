/**
 * CommsTool's version-reporting formatting and the query_version action handler (agent-comms#198) -- split out of tool.ts purely to keep that file under the repo's max-lines cap, the same reason gateway-trust-actions.ts and its siblings were split out before it. Free functions over MeshOnlyFeatures's own version methods rather than class methods, since CommsTool owns no state of its own for this concern -- every one of these is a pure translation from whatever the store/local process knows into either a CommsResult or a formatted line, mirroring gateway-trust-actions.ts's own shape.
 */
import type { CommsAction } from "./types.js";
import type { CommsResult, MeshOnlyFeatures } from "./tool.js";
import { notMeshBacked } from "./tool.js";
import { getOwnPackageVersion } from "./package-version.js";
import { getWireMeshCoreVersion } from "./wire-mesh-core-version.js";

/** The slice of MeshOnlyFeatures the functions below actually need. */
export type VersionReportStore = Pick<
  MeshOnlyFeatures,
  | "queryVersion"
  | "getPeerAgentCommsVersion"
  | "getPeerWireMeshCoreVersion"
  | "getPeerCcPeerVersion"
>;

/** Answers query_version by asking the target device for its own, currently-running wire-mesh-core version live, right now -- the cache-bust counterpart to whatever it last gossiped. */
export async function handleQueryVersion(
  store: Readonly<VersionReportStore>,
  action: CommsAction & { action: "query_version" },
): Promise<CommsResult> {
  if (!store.queryVersion) return notMeshBacked("query_version");
  const result = await store.queryVersion(action.device);
  if ("error" in result) {
    return {
      content: `Failed to query ${action.device}'s version: ${result.error}`,
      isError: true,
    };
  }
  return {
    content: `${action.device} is running wire-mesh-core ${result.version}.`,
    isError: false,
  };
}

/** This process's own wire-mesh-core version line, plus a cc-peer version line when getCcPeerVersion answers one -- whoami's own trailing version lines, appended after its existing "Version: ..." line. */
export function formatSelfVersionLines(
  getCcPeerVersion: (() => string | undefined) | undefined,
): string[] {
  const lines = [`Wire-mesh-core: ${getWireMeshCoreVersion()}`];
  const ccPeerVersion = getCcPeerVersion?.();
  if (ccPeerVersion !== undefined) lines.push(`Cc-peer: ${ccPeerVersion}`);
  return lines;
}

/** The trailing ", wireMeshCore=..., ccPeer=..." fragment update's own single summary line appends after its existing "version=..." field. */
export function formatSelfVersionSuffix(
  getCcPeerVersion: (() => string | undefined) | undefined,
): string {
  const ccPeerVersion = getCcPeerVersion?.();
  const ccPeerSuffix =
    ccPeerVersion !== undefined ? `, ccPeer=${ccPeerVersion}` : "";
  return `, wireMeshCore=${getWireMeshCoreVersion()}${ccPeerSuffix}`;
}

/** One listed agent's own "agent-comms X, wire-mesh-core Y[, cc-peer Z]" summary for list_agents -- read locally (this process's own installed versions) for the requester's own entry, or from whatever deviceId last gossiped for every other listed agent. "unknown" stands in for a value neither source has (a peer that hasn't gossiped yet, or is running an agent-comms/wire-mesh-core predating this feature) -- cc-peer is omitted entirely rather than shown as "unknown", since it is only ever present at all while that specific device is actually fronting/bridging cc-peer. */
export function formatListedAgentVersions(
  store: Readonly<VersionReportStore>,
  deviceId: string,
  isSelf: boolean,
  getCcPeerVersion: (() => string | undefined) | undefined,
): string {
  const agentCommsVersion = isSelf
    ? getOwnPackageVersion()
    : store.getPeerAgentCommsVersion?.(deviceId);
  const wireMeshCoreVersion = isSelf
    ? getWireMeshCoreVersion()
    : store.getPeerWireMeshCoreVersion?.(deviceId);
  const ccPeerVersion = isSelf
    ? getCcPeerVersion?.()
    : store.getPeerCcPeerVersion?.(deviceId);
  return [
    `agent-comms ${agentCommsVersion ?? "unknown"}`,
    `wire-mesh-core ${wireMeshCoreVersion ?? "unknown"}`,
    ...(ccPeerVersion !== undefined ? [`cc-peer ${ccPeerVersion}`] : []),
  ].join(", ");
}

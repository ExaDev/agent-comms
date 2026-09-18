/**
 * peer-versions -- the AGENT_COMMS_VERSION_GOSSIP_KEY gossip extension itself (agent-comms#198's own write side, wired into readvertiseGossip's extensions by gossip-directory.ts), plus reading a specific device's gossiped version facts back out of WireMeshTransport's mesh-wide listKnownDevices() aggregation (the read side), mirroring agent-registry.ts's isAgentSelfAdvert/listDiscoverableAgents and room-lifecycle.ts's isHostedRoomAdvert: the same "narrow an untrusted self-asserted gossip value" pattern, just for wire-mesh-core's own version key and this file's own AGENT_COMMS_VERSION_GOSSIP_KEY.
 */

import type { MeshTransport } from "./transport.js";

/** The domain-qualified gossip extension key this side writes its own agent-comms (and, when this process is fronting/bridging a cc-peer session, cc-peer) package versions under -- the same "one gossip fact per key" convention wire-mesh-transport.ts's own PRESENCE_GOSSIP_KEY/HOSTED_ROOMS_GOSSIP_KEY/AGENT_SELF_GOSSIP_KEY already established. Distinct from wire-mesh-core's own "wire-mesh/version" key (own-version.ts's CORE_VERSION_GOSSIP_KEY, injected automatically by wire-mesh-core itself since wire-mesh#179) -- that one reports wire-mesh-core's own version and needs no writing here at all. */
export const AGENT_COMMS_VERSION_GOSSIP_KEY = "agent-comms/version";

/** The gossip-safe shape this side's own package versions advertise under AGENT_COMMS_VERSION_GOSSIP_KEY. ccPeer is present only while this process is actually fronting a cc-peer session or running the one-shot `bridge cc-peer` command (front-runtime.ts/bridges/cc-peer/run.ts's own getCcPeerVersion) -- absent for every other bridge, which never loads the cc-peer package at all. */
export interface AgentCommsVersionsAdvert {
  agentComms: string;
  ccPeer?: string;
}

/** wire-mesh-core's own gossip extension key (own-version.ts's CORE_VERSION_GOSSIP_KEY, injected unconditionally into every self-advert since wire-mesh#179) -- not exported as a package subpath, so this side reads it back by its known, spec-documented string (spec/version.cddl) rather than importing the constant. */
const WIRE_MESH_CORE_VERSION_GOSSIP_KEY = "wire-mesh/version";

/** Narrows an untrusted gossiped value (a device's own advert[AGENT_COMMS_VERSION_GOSSIP_KEY], self-asserted by whichever peer advertised it) into an AgentCommsVersionsAdvert -- a malformed or non-conforming entry is silently skipped rather than treated as an error, the same convention every other gossip-extension consumer here already established. */
function isAgentCommsVersionsAdvert(
  value: unknown,
): value is AgentCommsVersionsAdvert {
  if (typeof value !== "object" || value === null) return false;
  if (!("agentComms" in value) || typeof value.agentComms !== "string")
    return false;
  if ("ccPeer" in value && typeof value.ccPeer !== "string") return false;
  return true;
}

/** This device's own gossiped wire-mesh-core version, if this side has heard it advertise one -- undefined when the device is unknown, its transport has no listKnownDevices capability, or (a wire-mesh-core older than #179) it simply never carried the key. */
export function getPeerWireMeshCoreVersion(
  transport: Readonly<Pick<MeshTransport, "listKnownDevices">>,
  deviceId: string,
): string | undefined {
  if (transport.listKnownDevices === undefined) return undefined;
  for (const entry of transport.listKnownDevices()) {
    if (entry.deviceId !== deviceId) continue;
    const version = entry.advert[WIRE_MESH_CORE_VERSION_GOSSIP_KEY];
    return typeof version === "string" ? version : undefined;
  }
  return undefined;
}

/** This device's own gossiped agent-comms/cc-peer versions, if this side has heard it advertise any -- undefined under the same conditions getPeerWireMeshCoreVersion documents, or when the device gossiped something that doesn't conform to AgentCommsVersionsAdvert's own shape. */
export function getPeerAgentCommsVersions(
  transport: Readonly<Pick<MeshTransport, "listKnownDevices">>,
  deviceId: string,
): AgentCommsVersionsAdvert | undefined {
  if (transport.listKnownDevices === undefined) return undefined;
  for (const entry of transport.listKnownDevices()) {
    if (entry.deviceId !== deviceId) continue;
    const candidate = entry.advert[AGENT_COMMS_VERSION_GOSSIP_KEY];
    return isAgentCommsVersionsAdvert(candidate) ? candidate : undefined;
  }
  return undefined;
}

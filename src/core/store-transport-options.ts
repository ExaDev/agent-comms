// The WireMeshTransport options that come from a MeshStore, in one place. The production bridge and the tests both build a transport for a store, and the fields listed here are the ones that decide what the transport says about the store on gossip and how it answers on its behalf; building them twice let a field be wired in one and forgotten in the other.

import type { MeshStore } from "./mesh-store.js";
import type { WireMeshTransportOptions } from "./wire-mesh-transport-options.js";

export function storeTransportOptions(
  store: MeshStore,
): Required<
  Pick<
    WireMeshTransportOptions,
    | "roomVerbHandlers"
    | "roomJoinApprovalTimeoutMs"
    | "verifyMembership"
    | "getCurrentPresence"
    | "getHostedRooms"
    | "getPublicRooms"
    | "getSelfAgentAdvert"
    | "getSelfAgentCard"
    | "gatewayTrust"
  >
> {
  return {
    roomVerbHandlers: store.roomVerbHandlers,
    roomJoinApprovalTimeoutMs: store.roomJoinApprovalTimeoutMs,
    verifyMembership: async (claim) => store.membership.verify(claim),
    getCurrentPresence: () => store.selfStatus,
    getHostedRooms: () => store.hostedRooms,
    getPublicRooms: () => store.publicRooms,
    getSelfAgentAdvert: () => store.selfAgentAdvert,
    getSelfAgentCard: () => store.selfAgentCard,
    gatewayTrust: store.gatewayTrust,
  };
}

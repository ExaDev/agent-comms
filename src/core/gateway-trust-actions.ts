/**
 * CommsTool's gateway-trust action handlers (agent-comms#156, extended by agent-comms#187's principal-keyed allowlist and agent-comms#193's tool-level `principal` flag) -- split out of tool.ts purely to keep that file under the repo's max-lines cap, the same reason agent-registry.ts, delivery-engine.ts, and their siblings were split from mesh-store.ts. Free functions over MeshOnlyFeatures's own gateway-trust methods rather than class methods, since CommsTool owns no state of its own for this concern -- every one of these is a pure translation from a CommsAction to a CommsResult against whatever store methods are present.
 */
import type { CommsAction } from "./types.js";
import type { CommsResult, MeshOnlyFeatures } from "./tool.js";

/** The slice of MeshOnlyFeatures the three functions below actually need, named so this file doesn't repeat the same six-method Pick inline at every signature. */
export type GatewayTrustStore = Pick<
  MeshOnlyFeatures,
  | "addTrustedGateway"
  | "removeTrustedGateway"
  | "listTrustedGateways"
  | "addTrustedGatewayPrincipal"
  | "removeTrustedGatewayPrincipal"
  | "listTrustedGatewayPrincipals"
  | "listVerifiedMembers"
>;

/** Uniform "gateway trust isn't available on this store" result, mirroring tool.ts's own notMeshBacked helper for the other MeshOnlyFeatures methods. */
function gatewayTrustUnavailable(): CommsResult {
  return {
    content: "Gateway trust is not available on this store.",
    isError: true,
  };
}

/** Trusts action.device: as a user principal (GatewayTrust.addPrincipal, agent-comms#187) when action.principal is true, or as a bare remote device-id (the original agent-comms#156 behaviour) otherwise. */
export function gatewayTrust(
  store: Readonly<GatewayTrustStore>,
  action: CommsAction & { action: "gateway_trust" },
): CommsResult {
  if (action.principal === true) {
    if (!store.addTrustedGatewayPrincipal) return gatewayTrustUnavailable();
    store.addTrustedGatewayPrincipal(action.device);
    return {
      content: `Trusted remote gateway principal ${action.device}.`,
      isError: false,
    };
  }
  if (!store.addTrustedGateway) return gatewayTrustUnavailable();
  store.addTrustedGateway(action.device);
  return {
    content: `Trusted remote gateway device ${action.device}.`,
    isError: false,
  };
}

/** Withdraws trust from action.device: from the principal allowlist (GatewayTrust.removePrincipal, agent-comms#187) when action.principal is true, or from the bare-device allowlist (the original agent-comms#156 behaviour) otherwise. */
export function gatewayUntrust(
  store: Readonly<GatewayTrustStore>,
  action: CommsAction & { action: "gateway_untrust" },
): CommsResult {
  if (action.principal === true) {
    if (!store.removeTrustedGatewayPrincipal) return gatewayTrustUnavailable();
    store.removeTrustedGatewayPrincipal(action.device);
    return {
      content: `Untrusted remote gateway principal ${action.device}.`,
      isError: false,
    };
  }
  if (!store.removeTrustedGateway) return gatewayTrustUnavailable();
  store.removeTrustedGateway(action.device);
  return {
    content: `Untrusted remote gateway device ${action.device}.`,
    isError: false,
  };
}

/** Reports every currently trusted remote device-id and every currently trusted principal device-id (agent-comms#187) together -- listing is never mutually exclusive between the two sets, so, unlike gatewayTrust/gatewayUntrust above, this needs no `principal` flag of its own. */
export function gatewayListTrusted(
  store: Readonly<GatewayTrustStore>,
): CommsResult {
  if (!store.listTrustedGateways) return gatewayTrustUnavailable();
  const devices = store.listTrustedGateways();
  const principals = store.listTrustedGatewayPrincipals?.() ?? [];
  const members = store.listVerifiedMembers?.() ?? [];
  if (devices.length === 0 && principals.length === 0 && members.length === 0) {
    return {
      content: "No remote gateway devices or principals are trusted.",
      isError: false,
    };
  }
  const sections: string[] = [];
  if (devices.length > 0) {
    sections.push(
      `Trusted remote gateway devices:\n${devices.map((device) => `  ${device}`).join("\n")}`,
    );
  }
  if (principals.length > 0) {
    sections.push(
      `Trusted remote gateway principals:\n${principals.map((principal) => `  ${principal}`).join("\n")}`,
    );
  }
  if (members.length > 0) {
    sections.push(
      `Devices trusted through a principal:\n${members.map((member) => `  ${member.device} (vouched for by ${member.principal})`).join("\n")}`,
    );
  }
  return {
    content: sections.join("\n"),
    isError: false,
  };
}

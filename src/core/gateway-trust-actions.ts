/**
 * CommsTool's gateway-trust action handlers (agent-comms#156) -- split out of tool.ts purely to keep that file under the repo's max-lines cap, the same reason agent-registry.ts, delivery-engine.ts, and their siblings were split from mesh-store.ts. Free functions over MeshOnlyFeatures's own gateway-trust methods rather than class methods, since CommsTool owns no state of its own for this concern -- every one of these is a pure translation from a CommsAction to a CommsResult against whatever store methods are present.
 */
import type { CommsAction } from "./types.js";
import type { CommsResult, MeshOnlyFeatures } from "./tool.js";

/** The slice of MeshOnlyFeatures the three functions below actually need, named so this file doesn't repeat the same three-method Pick inline at every signature. */
export type GatewayTrustStore = Pick<
  MeshOnlyFeatures,
  "addTrustedGateway" | "removeTrustedGateway" | "listTrustedGateways"
>;

/** Uniform "gateway trust isn't available on this store" result. */
function gatewayTrustUnavailable(): CommsResult {
  return {
    content: "Gateway trust is not available on this store.",
    isError: true,
  };
}

/** Trusts a remote device-id: this side will merge its gossiped directory entries, dispatch its relayed requests, and route outbound hub requests to it. */
export function gatewayTrust(
  store: Readonly<GatewayTrustStore>,
  action: CommsAction & { action: "gateway_trust" },
): CommsResult {
  if (!store.addTrustedGateway) return gatewayTrustUnavailable();
  store.addTrustedGateway(action.device);
  return {
    content: `Trusted remote gateway device ${action.device}.`,
    isError: false,
  };
}

/** Withdraws trust from a previously trusted remote device-id. */
export function gatewayUntrust(
  store: Readonly<GatewayTrustStore>,
  action: CommsAction & { action: "gateway_untrust" },
): CommsResult {
  if (!store.removeTrustedGateway) return gatewayTrustUnavailable();
  store.removeTrustedGateway(action.device);
  return {
    content: `Untrusted remote gateway device ${action.device}.`,
    isError: false,
  };
}

/** Reports every currently trusted remote device-id. */
export function gatewayListTrusted(
  store: Readonly<GatewayTrustStore>,
): CommsResult {
  if (!store.listTrustedGateways) return gatewayTrustUnavailable();
  const trusted = store.listTrustedGateways();
  if (trusted.length === 0) {
    return {
      content: "No remote gateway devices are trusted.",
      isError: false,
    };
  }
  return {
    content: `Trusted remote gateway devices:\n${trusted.map((device) => `  ${device}`).join("\n")}`,
    isError: false,
  };
}

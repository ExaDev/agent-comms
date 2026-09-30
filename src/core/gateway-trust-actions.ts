/**
 * CommsTool's gateway-trust action handlers (agent-comms#156, extended by agent-comms#187's principal-keyed allowlist, agent-comms#193's tool-level `principal` flag and agent-comms#343's `machine` flag), split out of tool.ts to keep that file under the repo's max-lines cap, the same reason agent-registry.ts, delivery-engine.ts, and their siblings were split from mesh-store.ts. Free functions over MeshOnlyFeatures's own gateway-trust methods rather than class methods, since CommsTool owns no state of its own for this concern: every one of these is a pure translation from a CommsAction to a CommsResult against whatever store methods are present.
 */
import { isDeviceIdHex } from "./room-path.js";
import type { CommsAction } from "./types.js";
import type { CommsResult, MeshOnlyFeatures } from "./tool.js";

/** The slice of MeshOnlyFeatures the three functions below actually need, named so this file doesn't repeat the same Pick inline at every signature. */
export type GatewayTrustStore = Pick<
  MeshOnlyFeatures,
  | "addTrustedGateway"
  | "removeTrustedGateway"
  | "listTrustedGateways"
  | "addTrustedGatewayPrincipal"
  | "removeTrustedGatewayPrincipal"
  | "listTrustedGatewayPrincipals"
  | "addTrustedGatewayMachine"
  | "removeTrustedGatewayMachine"
  | "listTrustedGatewayMachines"
  | "listVerifiedMembers"
>;

/** The result for an id named as both a principal and a machine: the two are different kinds of issuer, so one id is at most one of them. */
function principalOrMachine(): CommsResult {
  return {
    content: "Pass principal or machine, not both.",
    isError: true,
  };
}

/** The result for an id that is not a full device-id. Trusting one would persist an entry that matches no real device, principal or machine, yet still count towards hasAny and so start this side advertising on the hub. */
function notADeviceId(device: string): CommsResult {
  return {
    content: `${JSON.stringify(device)} is not a device-id: pass the full 64-character hex id (whoami prints this side's).`,
    isError: true,
  };
}

/** Uniform "gateway trust isn't available on this store" result, mirroring tool.ts's own notMeshBacked helper for the other MeshOnlyFeatures methods. */
function gatewayTrustUnavailable(): CommsResult {
  return {
    content: "Gateway trust is not available on this store.",
    isError: true,
  };
}

/** Trusts action.device: as a user principal (GatewayTrust.addPrincipal, agent-comms#187) when action.principal is true, as a machine (GatewayTrust.addMachine, agent-comms#343) when action.machine is true, or as a bare remote device-id (the original agent-comms#156 behaviour) otherwise. */
export function gatewayTrust(
  store: Readonly<GatewayTrustStore>,
  action: CommsAction & { action: "gateway_trust" },
): CommsResult {
  if (action.principal === true && action.machine === true) {
    return principalOrMachine();
  }
  if (!isDeviceIdHex(action.device.toLowerCase())) {
    return notADeviceId(action.device);
  }
  if (action.machine === true) {
    if (!store.addTrustedGatewayMachine) return gatewayTrustUnavailable();
    store.addTrustedGatewayMachine(action.device);
    return {
      content: `Trusted remote machine ${action.device}: every device it vouches for is now reachable.`,
      isError: false,
    };
  }
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

/** Withdraws trust from action.device: from the principal allowlist (GatewayTrust.removePrincipal, agent-comms#187) when action.principal is true, from the machine allowlist (GatewayTrust.removeMachine, agent-comms#343, revoking every device it vouches for at once) when action.machine is true, or from the bare-device allowlist (the original agent-comms#156 behaviour) otherwise. */
export function gatewayUntrust(
  store: Readonly<GatewayTrustStore>,
  action: CommsAction & { action: "gateway_untrust" },
): CommsResult {
  if (action.principal === true && action.machine === true) {
    return principalOrMachine();
  }
  if (
    !isDeviceIdHex(action.device.toLowerCase()) &&
    !listedForUntrust(store, action)
  ) {
    return notADeviceId(action.device);
  }
  if (action.machine === true) {
    if (!store.removeTrustedGatewayMachine) return gatewayTrustUnavailable();
    store.removeTrustedGatewayMachine(action.device);
    return {
      content: `Untrusted remote machine ${action.device}: no device is reachable through it any more.`,
      isError: false,
    };
  }
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

/** Whether action.device is already in the set gateway_untrust would remove it from, so an entry an earlier version persisted without checking its shape can still be withdrawn through the tool. */
function listedForUntrust(
  store: Readonly<GatewayTrustStore>,
  action: CommsAction & { action: "gateway_untrust" },
): boolean {
  const listed =
    action.machine === true
      ? store.listTrustedGatewayMachines?.()
      : action.principal === true
        ? store.listTrustedGatewayPrincipals?.()
        : store.listTrustedGateways?.();
  return listed?.includes(action.device.toLowerCase()) === true;
}

/** Reports every currently trusted remote device-id, principal (agent-comms#187) and machine (agent-comms#343) together, and the devices reachable through a trusted principal or machine. Listing is never mutually exclusive between the sets, so, unlike gatewayTrust/gatewayUntrust above, this needs no flag of its own. */
export function gatewayListTrusted(
  store: Readonly<GatewayTrustStore>,
): CommsResult {
  if (!store.listTrustedGateways) return gatewayTrustUnavailable();
  const devices = store.listTrustedGateways();
  const principals = store.listTrustedGatewayPrincipals?.() ?? [];
  const machines = store.listTrustedGatewayMachines?.() ?? [];
  const members = store.listVerifiedMembers?.() ?? [];
  const sections: string[] = [];
  const section = (title: string, lines: readonly string[]): void => {
    if (lines.length > 0) {
      sections.push(
        `${title}:\n${lines.map((line) => `  ${line}`).join("\n")}`,
      );
    }
  };
  section("Trusted remote gateway devices", devices);
  section("Trusted remote gateway principals", principals);
  section("Trusted remote machines", machines);
  section(
    "Devices trusted through a principal",
    members
      .filter((member) => member.kind === "principal")
      .map((member) => `${member.device} (vouched for by ${member.issuer})`),
  );
  section(
    "Devices trusted through a machine",
    members
      .filter((member) => member.kind === "machine")
      .map((member) => `${member.device} (runs on ${member.issuer})`),
  );
  if (sections.length === 0) {
    return {
      content: "No remote gateway devices, principals or machines are trusted.",
      isError: false,
    };
  }
  return {
    content: sections.join("\n"),
    isError: false,
  };
}

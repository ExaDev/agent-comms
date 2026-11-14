/**
 * Trusted identifiers match case-insensitively: an entry a file holds in upper case is found by a lookup, and removed by a removal, in any case.
 */
import { expect, it } from "vitest";
import { GatewayTrust } from "../core/gateway-trust.js";
import { saveGatewayTrust, type IdentitySlot } from "../core/identity-store.js";
import { scratchDirectory } from "./scratch-directory.helper.js";

/** A device-id in hex is the SHA-256 of a key: 32 bytes. */
const DEVICE_ID_BYTES = 32;
const DEVICE = "ab".repeat(DEVICE_ID_BYTES);
const PRINCIPAL = "cd".repeat(DEVICE_ID_BYTES);
const MACHINE = "ef".repeat(DEVICE_ID_BYTES);

function slotHoldingUpperCase(): IdentitySlot {
  const slot: IdentitySlot = {
    harness: "case",
    cwd: "/tmp/case",
    dir: scratchDirectory("agent-comms-trust-case-"),
  };
  saveGatewayTrust(slot, {
    devices: [DEVICE.toUpperCase()],
    principals: [PRINCIPAL.toUpperCase()],
    machines: [MACHINE.toUpperCase()],
  });
  return slot;
}

it("finds and removes a device the file holds in another case", () => {
  const trust = new GatewayTrust({ location: slotHoldingUpperCase() });

  expect(trust.isTrusted(DEVICE)).toBe(true);
  trust.remove(DEVICE);

  expect(trust.isTrusted(DEVICE)).toBe(false);
  expect(trust.list()).toEqual([]);
});

it("finds and removes a principal and a machine the file holds in another case", () => {
  const trust = new GatewayTrust({ location: slotHoldingUpperCase() });

  expect(trust.isTrustedPrincipal(PRINCIPAL)).toBe(true);
  trust.removePrincipal(PRINCIPAL);
  trust.removeMachine(MACHINE);

  expect(trust.isTrustedPrincipal(PRINCIPAL)).toBe(false);
  expect(trust.listMachines()).toEqual([]);
});

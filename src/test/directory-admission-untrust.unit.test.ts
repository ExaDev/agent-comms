/**
 * A cached positive verdict on a gossiped proof never keeps a device admitted after the issuer that vouched for it is no longer trusted: admission re-checks that the issuer still vouches on every batch, whatever the cache holds.
 */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { deviceIdFromHex } from "wire-mesh-core/domain/device-id";
import type { DirectoryEntry } from "wire-mesh-core/domain/mesh-session";
import { directoryAdmission } from "../core/directory-admission.js";
import { GatewayTrust } from "../core/gateway-trust.js";
import { syntheticAdvert } from "./synthetic-advert.js";

const DEVICE_ID_HEX_LENGTH = 64;
const ONE_HOUR_MS = 3_600_000;
const PRINCIPAL = "a".repeat(DEVICE_ID_HEX_LENGTH);
const MACHINE = "c".repeat(DEVICE_ID_HEX_LENGTH);

function entryWith(
  label: string,
  proofs: Readonly<{ membership?: string; machine?: string }>,
): DirectoryEntry {
  const device = deviceIdFromHex(
    createHash("sha256").update(label).digest("hex"),
  );
  return {
    device,
    advert: syntheticAdvert(device, {
      snapshotSeconds: 1,
      extensions: { "agent/self": proofs },
    }),
  };
}

const vouching = async (): Promise<{ ok: true; expires: number }> =>
  Promise.resolve({ ok: true, expires: Date.now() + ONE_HOUR_MS });

describe("directoryAdmission after the issuer is untrusted", () => {
  it("stops admitting a device whose verdict is cached once its principal is untrusted", async () => {
    const trust = new GatewayTrust();
    trust.addPrincipal(PRINCIPAL);
    const verifyMembership = vi.fn(vouching);
    const admit = directoryAdmission({ gatewayTrust: trust, verifyMembership });
    const entry = entryWith("cached-principal", { membership: "proof" });

    expect(await admit([entry])).toHaveLength(1);
    // The verdict is cached: a second batch does not ask the verifier again.
    expect(await admit([entry])).toHaveLength(1);
    expect(verifyMembership).toHaveBeenCalledTimes(1);

    trust.removePrincipal(PRINCIPAL);

    expect(await admit([entry])).toEqual([]);
  });

  it("stops admitting a device whose verdict is cached once its machine is untrusted", async () => {
    const trust = new GatewayTrust();
    trust.addMachine(MACHINE);
    const verifyMembership = vi.fn(vouching);
    const admit = directoryAdmission({ gatewayTrust: trust, verifyMembership });
    const entry = entryWith("cached-machine", { machine: "proof" });

    expect(await admit([entry])).toHaveLength(1);
    expect(await admit([entry])).toHaveLength(1);
    expect(verifyMembership).toHaveBeenCalledTimes(1);

    trust.removeMachine(MACHINE);

    expect(await admit([entry])).toEqual([]);
  });
});

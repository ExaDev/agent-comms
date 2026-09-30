/**
 * Unit tests for list_agents' machine placement (machine-grouping.ts). The identify step is a stub, so what is under test is which devices get placed and how a failure to identify one is contained, not the cryptography (membership-proof.unit.test.ts).
 */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MachineGrouping } from "../core/machine-grouping.js";
import type { IdentifiedMembershipProof } from "../core/membership-proof.js";

const ONE_HOUR_MS = 3_600_000;

/** A stable, valid device id for a label, so each test names its devices instead of numbering them. */
function hex(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

/** A known device whose agent/self advert carries the given machine proof. */
function known(
  label: string,
  machineProof: string,
): { deviceId: string; advert: Record<string, unknown> } {
  return {
    deviceId: hex(label),
    advert: { "agent/self": { machine: machineProof } },
  };
}

type Identify = (
  claim: Readonly<{ proof: string; deviceHex: string }>,
) => Promise<IdentifiedMembershipProof>;

describe("MachineGrouping", () => {
  it("reports a proof it cannot identify, leaves that device unplaced, and still places the others", async () => {
    const onError = vi.fn<(error: Error) => void>();
    const identify = vi.fn<Identify>(async (claim) =>
      claim.proof === "broken"
        ? Promise.reject(new Error("revocation view unavailable"))
        : Promise.resolve({
            ok: true,
            issuerHex: hex("remote-machine"),
            expires: Date.now() + ONE_HOUR_MS,
          }),
    );
    const grouping = new MachineGrouping({
      listKnownDevices: () => [
        known("unidentifiable", "broken"),
        known("placed", "good"),
      ],
      identify,
      getPeerId: () => hex("self"),
      getMachineId: () => hex("own-machine"),
      onError,
    });

    const machines = await grouping.machinesByDevice();

    expect(machines).toEqual(
      new Map([
        [hex("self"), hex("own-machine")],
        [hex("placed"), hex("remote-machine")],
      ]),
    );
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0].message).toContain(hex("unidentifiable"));
  });

  it("tries a proof it could not identify again on the next listing, since the failure was not a verdict on the proof", async () => {
    const identify = vi.fn<Identify>(async () =>
      Promise.reject(new Error("revocation view unavailable")),
    );
    const grouping = new MachineGrouping({
      listKnownDevices: () => [known("retried", "proof")],
      identify,
      getPeerId: () => hex("self"),
      getMachineId: () => hex("own-machine"),
      onError: () => undefined,
    });

    await grouping.machinesByDevice();
    await grouping.machinesByDevice();

    expect(identify).toHaveBeenCalledTimes(2);
  });
});

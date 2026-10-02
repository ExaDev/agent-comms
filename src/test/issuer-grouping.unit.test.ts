/**
 * Unit tests for list_agents' issuer placement (issuer-grouping.ts). The identify step is a stub, so what is under test is which devices get placed and how a failure to identify one is contained, not the cryptography (membership-proof.unit.test.ts).
 */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { IssuerGrouping } from "../core/issuer-grouping.js";
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

/** The naming deps for adverts that carry no name claim: verifying one would mean the test's fixtures are not what it says, so it fails loudly. */
const noNames = {
  field: "machine",
  readNameClaim: () => undefined,
  verifyName: async () =>
    Promise.reject(new Error("these adverts carry no name claim")),
  getOwnName: () => undefined,
} as const;

describe("IssuerGrouping", () => {
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
    const grouping = new IssuerGrouping({
      listKnownDevices: () => [
        known("unidentifiable", "broken"),
        known("placed", "good"),
      ],
      identify,
      getPeerId: () => hex("self"),
      getOwnIssuerId: () => hex("own-machine"),
      onError,
      ...noNames,
    });

    const machines = await grouping.issuersByDevice();

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
    const grouping = new IssuerGrouping({
      listKnownDevices: () => [known("retried", "proof")],
      identify,
      getPeerId: () => hex("self"),
      getOwnIssuerId: () => hex("own-machine"),
      onError: () => undefined,
      ...noNames,
    });

    await grouping.issuersByDevice();
    await grouping.issuersByDevice();

    expect(identify).toHaveBeenCalledTimes(2);
  });
});

describe("IssuerGrouping names", () => {
  const principal = hex("principal");

  /** A known device whose advert carries a principal proof and the given principal name claim. */
  function principalDevice(
    label: string,
    claim: string,
  ): { deviceId: string; advert: Record<string, unknown> } {
    return {
      deviceId: hex(label),
      advert: { "agent/self": { membership: "proof", principalName: claim } },
    };
  }

  function grouping(
    devices: readonly ReturnType<typeof principalDevice>[],
    verdict: (claim: string, subject: string) => boolean,
    ownName?: string,
  ): IssuerGrouping {
    return new IssuerGrouping({
      field: "membership",
      readNameClaim: (advert) => {
        const self: unknown = advert["agent/self"];
        return typeof self === "object" &&
          self !== null &&
          "principalName" in self &&
          typeof self.principalName === "string"
          ? self.principalName
          : undefined;
      },
      listKnownDevices: () => devices,
      identify: async () =>
        Promise.resolve({
          ok: true,
          issuerHex: principal,
          expires: Date.now() + ONE_HOUR_MS,
        }),
      getPeerId: () => hex("self"),
      getOwnIssuerId: () => hex("own-principal"),
      onError: () => undefined,
      verifyName: async ({ claim, subject }) =>
        Promise.resolve(
          verdict(claim, subject)
            ? { ok: true, name: claim, expires: Date.now() + ONE_HOUR_MS }
            : { ok: false, reason: "bad_signature" },
        ),
      getOwnName: () => ownName,
    });
  }

  it("keeps a name only when its claim verifies against the principal the device's proof names", async () => {
    const names = await grouping(
      [
        principalDevice("signed", "alice"),
        principalDevice("forged", "mallory"),
      ],
      (claim, subject) => claim === "alice" && subject === principal,
    ).issuerNames();

    expect(names).toEqual(new Map([[principal, "alice"]]));
  });

  it("names this device's own principal from its own file, ahead of any gossiped claim", async () => {
    const names = await grouping([], () => true, "own account").issuerNames();

    expect(names).toEqual(new Map([[hex("own-principal"), "own account"]]));
  });

  it("does not look at a name claim for a device whose proof is not valid", async () => {
    const verify = vi.fn(() => true);
    const refusing = new IssuerGrouping({
      field: "membership",
      readNameClaim: () => "alice",
      listKnownDevices: () => [principalDevice("unproven", "alice")],
      identify: async () => Promise.resolve({ ok: false, reason: "expired" }),
      getPeerId: () => hex("self"),
      getOwnIssuerId: () => hex("own-principal"),
      onError: () => undefined,
      verifyName: async () => {
        verify();
        return Promise.resolve({ ok: false, reason: "unreachable" });
      },
      getOwnName: () => undefined,
    });

    expect(await refusing.issuerNames()).toEqual(new Map());
    expect(verify).not.toHaveBeenCalled();
  });
});

/**
 * How often GatewayTrust looks at the shared trust file. A node answers trust questions for every directory entry it merges, so the look has to be rare by construction; these tests count the looks (never time them) through an injected clock and pin both halves of the bound: reads inside the interval cost none, and a change made by another process is seen once the interval has passed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GatewayTrust,
  TRUST_FILE_RECHECK_INTERVAL_MS,
} from "../core/gateway-trust.js";
import type * as identityStore from "../core/identity-store.js";
import type { IdentitySlot } from "../core/identity-store.js";
import { manualClock } from "./manual-clock.js";
import { scratchDirectory } from "./scratch-directory.helper.js";

const stamps = vi.hoisted(() => ({ calls: 0 }));

vi.mock("../core/identity-store.js", async (importOriginal) => {
  const original = await importOriginal<typeof identityStore>();

  return {
    ...original,
    gatewayTrustStamp: (
      ...args: Parameters<typeof original.gatewayTrustStamp>
    ) => {
      stamps.calls += 1;

      return original.gatewayTrustStamp(...args);
    },
  };
});

/** Questions asked of one trust boundary in the interval, standing in for the directory entries a busy hub merges. */
const QUESTIONS = 500;

function tempSlot(): IdentitySlot {
  const dir = scratchDirectory("agent-comms-trust-recheck-");

  return { harness: "pi", cwd: "/tmp/project", dir };
}

describe("GatewayTrust trust-file rechecks", () => {
  beforeEach(() => {
    stamps.calls = 0;
  });

  it("looks at the file once for any number of reads inside one interval", () => {
    const slot = tempSlot();
    const clock = manualClock();
    const trust = new GatewayTrust({ location: slot, clock: clock });
    const afterConstruction = stamps.calls;

    for (let question = 0; question < QUESTIONS; question += 1) {
      trust.isTrusted("aabbcc");
      trust.isTrustedPrincipal("aabbcc");
      trust.hasAny();
    }

    expect(stamps.calls - afterConstruction).toBe(0);
  });

  it("looks again once the interval has passed, and only once per interval", () => {
    const slot = tempSlot();
    const clock = manualClock();
    const trust = new GatewayTrust({ location: slot, clock: clock });
    const afterConstruction = stamps.calls;

    clock.advance(TRUST_FILE_RECHECK_INTERVAL_MS);
    for (let question = 0; question < QUESTIONS; question += 1) {
      trust.isTrusted("aabbcc");
    }

    expect(stamps.calls - afterConstruction).toBe(1);
  });

  it("sees another process's revocation within the interval's bound, and not before", () => {
    const slot = tempSlot();
    const clock = manualClock();
    const reader = new GatewayTrust({ location: slot, clock: clock });
    const other = new GatewayTrust({ location: slot, clock: manualClock() });
    other.add("aabbcc");
    clock.advance(TRUST_FILE_RECHECK_INTERVAL_MS);
    expect(reader.isTrusted("aabbcc")).toBe(true);

    other.remove("aabbcc");

    expect(
      reader.isTrusted("aabbcc"),
      "a read inside the interval may still rest on the last look",
    ).toBe(true);
    clock.advance(TRUST_FILE_RECHECK_INTERVAL_MS);
    expect(
      reader.isTrusted("aabbcc"),
      "once the interval has passed the revocation is seen",
    ).toBe(false);
  });

  it("never lets a write rest on a stale look, so one process cannot erase another's change", () => {
    const slot = tempSlot();
    const clock = manualClock();
    const first = new GatewayTrust({ location: slot, clock: clock });
    const second = new GatewayTrust({ location: slot, clock: manualClock() });
    second.add("ddeeff");

    first.add("aabbcc");

    expect(
      new GatewayTrust({ location: slot }).list().sort(),
      "the write re-read the file first, keeping the other process's entry",
    ).toEqual(["aabbcc", "ddeeff"]);
  });
});

/**
 * Unit tests for self display name claims (core/name-claim, agent-comms#345): the issuer is authentic, the content is the issuer's own, and nothing else verifies.
 */

import { describe, expect, it } from "vitest";
import { createSystemClock } from "wire-mesh-core/adapters/system-clock";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import type { Clock } from "wire-mesh-core/ports/clock";
import { generateIdentity } from "../core/identity.js";
import { toIdentityPort } from "../core/wire-mesh-identity.js";
import { mintNameClaim, verifyNameClaim } from "../core/name-claim.js";

const LIFETIME_MS = 60_000;

async function port() {
  return toIdentityPort(generateIdentity());
}

/** Decodes a claim's text to its wire object, for tests that tamper with one field. */
function decode(claim: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(
    Buffer.from(claim, "base64url").toString("utf-8"),
  );
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("claim is not an object");
  }
  return Object.fromEntries(Object.entries(parsed));
}

function encode(wire: Readonly<Record<string, unknown>>): string {
  return Buffer.from(JSON.stringify(wire), "utf-8").toString("base64url");
}

describe("name claim", () => {
  it("verifies for its own subject and yields the name the subject chose", async () => {
    const machine = await port();
    const verifier = await port();
    const clock = createSystemClock();
    const claim = await mintNameClaim({
      issuer: machine,
      clock,
      name: "joe-mbp",
      lifetimeMs: LIFETIME_MS,
    });

    const verdict = await verifyNameClaim({
      claim,
      subject: deviceIdToHex(machine.deviceId),
      identity: verifier,
      clock,
    });

    expect(verdict).toMatchObject({ ok: true, name: "joe-mbp" });
  });

  it("does not verify for any other subject", async () => {
    const machine = await port();
    const other = await port();
    const clock = createSystemClock();
    const claim = await mintNameClaim({
      issuer: machine,
      clock,
      name: "joe-mbp",
      lifetimeMs: LIFETIME_MS,
    });

    const verdict = await verifyNameClaim({
      claim,
      subject: deviceIdToHex(other.deviceId),
      identity: other,
      clock,
    });

    expect(verdict).toEqual({ ok: false, reason: "wrong_subject" });
  });

  it("refuses a claim relabelled to name another subject, since its key is not that subject's", async () => {
    const impostor = await port();
    const victim = await port();
    const clock = createSystemClock();
    const claim = await mintNameClaim({
      issuer: impostor,
      clock,
      name: "victim's name",
      lifetimeMs: LIFETIME_MS,
    });
    const victimHex = deviceIdToHex(victim.deviceId);

    const verdict = await verifyNameClaim({
      claim: encode({ ...decode(claim), subject: victimHex }),
      subject: victimHex,
      identity: victim,
      clock,
    });

    expect(verdict).toEqual({ ok: false, reason: "wrong_key" });
  });

  it("refuses a claim whose name was changed after signing", async () => {
    const machine = await port();
    const clock = createSystemClock();
    const claim = await mintNameClaim({
      issuer: machine,
      clock,
      name: "joe-mbp",
      lifetimeMs: LIFETIME_MS,
    });

    const verdict = await verifyNameClaim({
      claim: encode({ ...decode(claim), name: "someone-else" }),
      subject: deviceIdToHex(machine.deviceId),
      identity: machine,
      clock,
    });

    expect(verdict).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses an expired claim", async () => {
    const machine = await port();
    const minted = createSystemClock();
    const claim = await mintNameClaim({
      issuer: machine,
      clock: minted,
      name: "joe-mbp",
      lifetimeMs: LIFETIME_MS,
    });
    const later: Clock = { now: () => minted.now() + LIFETIME_MS + 1 };

    const verdict = await verifyNameClaim({
      claim,
      subject: deviceIdToHex(machine.deviceId),
      identity: machine,
      clock: later,
    });

    expect(verdict).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses a signed name that carries a control sequence, and text that is not a claim", async () => {
    const machine = await port();
    const clock = createSystemClock();
    const subject = deviceIdToHex(machine.deviceId);
    const claim = await mintNameClaim({
      issuer: machine,
      clock,
      name: "evil\u001b[2J",
      lifetimeMs: LIFETIME_MS,
    });

    expect(
      await verifyNameClaim({ claim, subject, identity: machine, clock }),
    ).toEqual({ ok: false, reason: "unusable_name" });
    expect(
      await verifyNameClaim({
        claim: "not a claim",
        subject,
        identity: machine,
        clock,
      }),
    ).toEqual({ ok: false, reason: "not_a_claim" });
  });
});

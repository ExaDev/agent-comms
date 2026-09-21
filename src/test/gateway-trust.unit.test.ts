/**
 * Direct unit tests for GatewayTrust -- the cross-machine trust boundary's own allowlist (agent-comms#156), tested standalone against no real transport or hub socket, mirroring coordinator-gateway.test.ts's own approach for the sibling gateway-lifecycle class. Also covers persistence (agent-comms#186) and its sharing across every store in an identity directory (agent-comms#293): loading a previously trusted set on construction, writing it back on every change, and picking up a change another instance made.
 */
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayTrust } from "../core/gateway-trust.js";
import type { IdentitySlot } from "../core/identity-store.js";

function tempSlot(harness: string): IdentitySlot {
  const dir = fs.mkdtempSync(
    path.join(tmpdir(), "agent-comms-gateway-trust-test-"),
  );
  return { harness, cwd: "/tmp/project", dir };
}

describe("GatewayTrust", () => {
  it("trusts nobody by default", () => {
    const trust = new GatewayTrust();
    expect(trust.hasAny()).toBe(false);
    expect(trust.isTrusted("aabbcc")).toBe(false);
    expect(trust.list()).toEqual([]);
  });

  it("trusts a device once added", () => {
    const trust = new GatewayTrust();
    trust.add("AABBCC");
    expect(trust.isTrusted("aabbcc")).toBe(true);
    expect(trust.hasAny()).toBe(true);
    expect(trust.list()).toEqual(["aabbcc"]);
  });

  it("normalises hex case so add and isTrusted agree regardless of casing", () => {
    const trust = new GatewayTrust();
    trust.add("AaBbCc");
    expect(trust.isTrusted("aabbcc")).toBe(true);
    expect(trust.isTrusted("AABBCC")).toBe(true);
  });

  it("is idempotent: adding the same device twice keeps it listed once", () => {
    const trust = new GatewayTrust();
    trust.add("aabbcc");
    trust.add("AABBCC");
    expect(trust.list()).toEqual(["aabbcc"]);
  });

  it("stops trusting a device once removed", () => {
    const trust = new GatewayTrust();
    trust.add("aabbcc");
    trust.remove("AABBCC");
    expect(trust.isTrusted("aabbcc")).toBe(false);
    expect(trust.list()).toEqual([]);
  });

  it("removing a device that was never trusted is a safe no-op", () => {
    const trust = new GatewayTrust();
    expect(() => {
      trust.remove("aabbcc");
    }).not.toThrow();
    expect(trust.list()).toEqual([]);
  });

  it("hasAny reflects removal down to empty", () => {
    const trust = new GatewayTrust();
    trust.add("aabbcc");
    trust.remove("aabbcc");
    expect(trust.hasAny()).toBe(false);
  });

  it("lists every currently trusted device once each device-id is trusted, unaffected by another device's own trust/untrust", () => {
    const trust = new GatewayTrust();
    trust.add("aabbcc");
    trust.add("ddeeff");
    trust.remove("aabbcc");
    expect(trust.list()).toEqual(["ddeeff"]);
  });
});

describe("GatewayTrust persistence (agent-comms#186)", () => {
  it("constructed with no slot, never touches disk and behaves exactly as before", () => {
    const trust = new GatewayTrust();
    trust.add("aabbcc");
    expect(trust.isTrusted("aabbcc")).toBe(true);
    expect(trust.list()).toEqual(["aabbcc"]);
  });

  it("constructed with a slot that has never saved a trusted set, starts empty", () => {
    const slot = tempSlot("pi");
    const trust = new GatewayTrust(slot);
    expect(trust.hasAny()).toBe(false);
    expect(trust.list()).toEqual([]);
  });

  it("loads a previously persisted trusted set on construction", () => {
    const slot = tempSlot("pi");
    new GatewayTrust(slot).add("aabbcc");

    const restarted = new GatewayTrust(slot);

    expect(restarted.isTrusted("aabbcc")).toBe(true);
    expect(restarted.list()).toEqual(["aabbcc"]);
  });

  it("persists an add immediately, visible to a fresh instance for the same slot without either instance restarting", () => {
    const slot = tempSlot("pi");
    const trust = new GatewayTrust(slot);
    trust.add("aabbcc");

    const other = new GatewayTrust(slot);

    expect(other.isTrusted("aabbcc")).toBe(true);
  });

  it("persists a remove, so a restarted instance no longer trusts the removed device", () => {
    const slot = tempSlot("pi");
    const first = new GatewayTrust(slot);
    first.add("aabbcc");
    first.add("ddeeff");
    first.remove("aabbcc");

    const restarted = new GatewayTrust(slot);

    expect(restarted.list()).toEqual(["ddeeff"]);
  });

  it("normalises hex case in the persisted set the same way the in-memory set is normalised", () => {
    const slot = tempSlot("pi");
    new GatewayTrust(slot).add("AaBbCc");

    const restarted = new GatewayTrust(slot);

    expect(restarted.list()).toEqual(["aabbcc"]);
  });

  it("two identity directories keep separate trust", () => {
    const slotA = tempSlot("pi");
    const slotB = tempSlot("pi");
    new GatewayTrust(slotA).add("aabbcc");

    expect(new GatewayTrust(slotB).list()).toEqual([]);
  });

  it("stores under different harnesses share one trusted set when they share an identity directory", () => {
    const pi = tempSlot("pi");
    const claudeCode: IdentitySlot = { ...pi, harness: "claude-code" };
    new GatewayTrust(pi).add("aabbcc");

    expect(new GatewayTrust(claudeCode).isTrusted("aabbcc")).toBe(true);
  });

  it("a running instance sees a device another instance trusted after it was constructed", () => {
    const slot = tempSlot("pi");
    const running = new GatewayTrust(slot);
    expect(running.hasAny()).toBe(false);

    new GatewayTrust(slot).add("aabbcc");

    expect(running.hasAny()).toBe(true);
    expect(running.isTrusted("aabbcc")).toBe(true);
    expect(running.isReachable("aabbcc")).toBe(true);
  });

  it("a running instance stops trusting a device another instance removed", () => {
    const slot = tempSlot("pi");
    const running = new GatewayTrust(slot);
    running.add("aabbcc");

    new GatewayTrust(slot).remove("aabbcc");

    expect(running.isTrusted("aabbcc")).toBe(false);
    expect(running.list()).toEqual([]);
  });

  it("a running instance sees a principal another instance trusted", () => {
    const slot = tempSlot("pi");
    const running = new GatewayTrust(slot);

    new GatewayTrust(slot).addPrincipal("112233");

    expect(running.isTrustedPrincipal("112233")).toBe(true);
    expect(running.listPrincipals()).toEqual(["112233"]);
  });

  it("a change applies on top of another instance's earlier change instead of overwriting it", () => {
    const slot = tempSlot("pi");
    const first = new GatewayTrust(slot);
    const second = new GatewayTrust(slot);
    first.add("aabbcc");

    second.add("ddeeff");

    expect(first.list()).toEqual(["aabbcc", "ddeeff"]);
    expect(new GatewayTrust(slot).list()).toEqual(["aabbcc", "ddeeff"]);
  });

  // Principal persistence (agent-comms#187) -- extends #186's own device-only persistence to the second, parallel principal allowlist, per #186's own issue text naming #187 as the one that decides what gets stored.
  it("persists a trusted principal, surviving a restart alongside the bare-device set", () => {
    const slot = tempSlot("pi");
    const first = new GatewayTrust(slot);
    first.add("aabbcc");
    first.addPrincipal("112233");

    const restarted = new GatewayTrust(slot);

    expect(restarted.list()).toEqual(["aabbcc"]);
    expect(restarted.listPrincipals()).toEqual(["112233"]);
  });

  it("persists a principal removal independently of the bare-device set", () => {
    const slot = tempSlot("pi");
    const first = new GatewayTrust(slot);
    first.addPrincipal("112233");
    first.addPrincipal("445566");
    first.removePrincipal("112233");

    const restarted = new GatewayTrust(slot);

    expect(restarted.listPrincipals()).toEqual(["445566"]);
  });
});

describe("GatewayTrust -- principal-keyed trust (agent-comms#187)", () => {
  it("trusts no principal by default", () => {
    const trust = new GatewayTrust();
    expect(trust.isTrustedPrincipal("aabbcc")).toBe(false);
    expect(trust.listPrincipals()).toEqual([]);
  });

  it("trusts a principal once added, independently of the bare-device set", () => {
    const trust = new GatewayTrust();
    trust.addPrincipal("AABBCC");
    expect(trust.isTrustedPrincipal("aabbcc")).toBe(true);
    expect(trust.listPrincipals()).toEqual(["aabbcc"]);
    expect(trust.isTrusted("aabbcc")).toBe(false);
  });

  it("normalises hex case for principals the same way it does for bare devices", () => {
    const trust = new GatewayTrust();
    trust.addPrincipal("AaBbCc");
    expect(trust.isTrustedPrincipal("aabbcc")).toBe(true);
    expect(trust.isTrustedPrincipal("AABBCC")).toBe(true);
  });

  it("is idempotent: adding the same principal twice keeps it listed once", () => {
    const trust = new GatewayTrust();
    trust.addPrincipal("aabbcc");
    trust.addPrincipal("AABBCC");
    expect(trust.listPrincipals()).toEqual(["aabbcc"]);
  });

  it("stops trusting a principal once removed", () => {
    const trust = new GatewayTrust();
    trust.addPrincipal("aabbcc");
    trust.removePrincipal("AABBCC");
    expect(trust.isTrustedPrincipal("aabbcc")).toBe(false);
    expect(trust.listPrincipals()).toEqual([]);
  });

  it("removing a principal that was never trusted is a safe no-op", () => {
    const trust = new GatewayTrust();
    expect(() => {
      trust.removePrincipal("aabbcc");
    }).not.toThrow();
    expect(trust.listPrincipals()).toEqual([]);
  });

  it("hasAny becomes true once a principal is trusted, even with no bare device ever trusted", () => {
    const trust = new GatewayTrust();
    expect(trust.hasAny()).toBe(false);
    trust.addPrincipal("aabbcc");
    expect(trust.hasAny()).toBe(true);
  });

  it("hasAny falls back to false once both the device and principal sets are empty again", () => {
    const trust = new GatewayTrust();
    trust.addPrincipal("aabbcc");
    trust.removePrincipal("aabbcc");
    expect(trust.hasAny()).toBe(false);
  });

  describe("isTrustedFor -- deciding trust from a verified token's own bearer and chain root", () => {
    it("passes a bearer that is itself directly trusted, regardless of its chain root", () => {
      const trust = new GatewayTrust();
      trust.add("aabbcc");
      expect(trust.isTrustedFor("aabbcc", "ffffff")).toBe(true);
    });

    it("passes a bearer whose chain roots at a trusted principal, even though the bearer itself was never individually trusted", () => {
      const trust = new GatewayTrust();
      trust.addPrincipal("ffffff");
      expect(trust.isTrustedFor("aabbcc", "ffffff")).toBe(true);
    });

    it("refuses a bearer that is neither directly trusted nor rooted at a trusted principal", () => {
      const trust = new GatewayTrust();
      expect(trust.isTrustedFor("aabbcc", "ffffff")).toBe(false);
    });

    it("is case-insensitive on both the bearer and the chain-root hex", () => {
      const trust = new GatewayTrust();
      trust.addPrincipal("FFFFFF");
      expect(trust.isTrustedFor("AABBCC", "ffffff")).toBe(true);
    });
  });
});

describe("GatewayTrust — verified members of a trusted principal", () => {
  const PRINCIPAL = "aabbccdd";
  const DEVICE = "11223344";
  const ONE_HOUR_MS = 3_600_000;

  afterEach(() => {
    vi.useRealTimers();
  });

  it("makes a device recorded as a verified member of a trusted principal reachable, without making it trusted by id", () => {
    const trust = new GatewayTrust();
    trust.addPrincipal(PRINCIPAL);

    trust.noteVerifiedMember(DEVICE, PRINCIPAL, Date.now() + ONE_HOUR_MS);

    expect(trust.isReachable(DEVICE)).toBe(true);
    expect(trust.isTrusted(DEVICE)).toBe(false);
  });

  it("matches device and principal ids case-insensitively, like every other id here", () => {
    const trust = new GatewayTrust();
    trust.addPrincipal(PRINCIPAL.toUpperCase());

    trust.noteVerifiedMember(
      DEVICE.toUpperCase(),
      PRINCIPAL,
      Date.now() + ONE_HOUR_MS,
    );

    expect(trust.isReachable(DEVICE)).toBe(true);
  });

  it("stops trusting the device the moment its principal is no longer trusted", () => {
    const trust = new GatewayTrust();
    trust.addPrincipal(PRINCIPAL);
    trust.noteVerifiedMember(DEVICE, PRINCIPAL, Date.now() + ONE_HOUR_MS);

    trust.removePrincipal(PRINCIPAL);

    expect(trust.isReachable(DEVICE)).toBe(false);
  });

  it("does not trust a device recorded against a principal that was never trusted", () => {
    const trust = new GatewayTrust();

    trust.noteVerifiedMember(DEVICE, PRINCIPAL, Date.now() + ONE_HOUR_MS);

    expect(trust.isReachable(DEVICE)).toBe(false);
  });

  it("stops trusting the device once its proof has expired", () => {
    vi.useFakeTimers();
    const trust = new GatewayTrust();
    trust.addPrincipal(PRINCIPAL);
    trust.noteVerifiedMember(DEVICE, PRINCIPAL, Date.now() + ONE_HOUR_MS);

    vi.advanceTimersByTime(ONE_HOUR_MS + 1);

    expect(trust.isReachable(DEVICE)).toBe(false);
  });

  it("lists only the members that are currently trusted, with the principal each was verified against", () => {
    vi.useFakeTimers();
    const trust = new GatewayTrust();
    trust.addPrincipal(PRINCIPAL);
    trust.noteVerifiedMember(DEVICE, PRINCIPAL, Date.now() + ONE_HOUR_MS);
    trust.noteVerifiedMember("55667788", PRINCIPAL, Date.now() + 1);
    trust.noteVerifiedMember("99aabbcc", "ffffffff", Date.now() + ONE_HOUR_MS);

    vi.advanceTimersByTime(2);

    expect(trust.listVerifiedMembers()).toEqual([
      { device: DEVICE, principal: PRINCIPAL },
    ]);
  });

  it("does not count a verified member as a bare-device trust, so it is not persisted or listed as one", () => {
    const trust = new GatewayTrust();
    trust.addPrincipal(PRINCIPAL);
    trust.noteVerifiedMember(DEVICE, PRINCIPAL, Date.now() + ONE_HOUR_MS);

    expect(trust.list()).toEqual([]);
  });

  it("reports a bare-trusted device as reachable too", () => {
    const trust = new GatewayTrust();
    trust.add(DEVICE);

    expect(trust.isReachable(DEVICE)).toBe(true);
  });

  it("never shortens a device's trust window when an older proof is noted after a newer one", () => {
    vi.useFakeTimers();
    const trust = new GatewayTrust();
    trust.addPrincipal(PRINCIPAL);
    trust.noteVerifiedMember(DEVICE, PRINCIPAL, Date.now() + ONE_HOUR_MS);

    trust.noteVerifiedMember(DEVICE, PRINCIPAL, Date.now() + 1);
    vi.advanceTimersByTime(ONE_HOUR_MS / 2);

    expect(trust.isReachable(DEVICE)).toBe(true);
  });

  it("forgets a principal's verified members when the principal is untrusted, so trusting it again does not revive them", () => {
    const trust = new GatewayTrust();
    trust.addPrincipal(PRINCIPAL);
    trust.noteVerifiedMember(DEVICE, PRINCIPAL, Date.now() + ONE_HOUR_MS);

    trust.removePrincipal(PRINCIPAL);
    trust.addPrincipal(PRINCIPAL);

    expect(trust.isReachable(DEVICE)).toBe(false);
  });
});

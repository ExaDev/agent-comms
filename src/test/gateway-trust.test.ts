/**
 * Direct unit tests for GatewayTrust -- the cross-machine trust boundary's own allowlist (agent-comms#156), tested standalone against no real transport or hub socket, mirroring coordinator-gateway.test.ts's own approach for the sibling gateway-lifecycle class. Also covers slot-based persistence (agent-comms#186): loading a previously trusted set on construction and writing it back on every add/remove.
 */
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
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

  it("two independent slots persist to distinct files and never see each other's trust", () => {
    const slotA = tempSlot("pi");
    const slotB = tempSlot("claude-code");
    new GatewayTrust(slotA).add("aabbcc");

    const restartedB = new GatewayTrust(slotB);

    expect(restartedB.list()).toEqual([]);
  });
});

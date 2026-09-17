/**
 * Direct unit tests for GatewayTrust -- the cross-machine trust boundary's own allowlist (agent-comms#156), tested standalone against no real transport or hub socket, mirroring coordinator-gateway.test.ts's own approach for the sibling gateway-lifecycle class.
 */
import { describe, expect, it } from "vitest";
import { GatewayTrust } from "../core/gateway-trust.js";

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

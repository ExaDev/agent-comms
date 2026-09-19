/**
 * toIdentityPort must produce the identical device-id identity.ts's own deriveDeviceId already computes for the same keypair -- the two are meant to be the same identity wrapped in two different envelopes, not two independent derivations that happen to usually agree.
 */

import { test, expect } from "vitest";
import { generateIdentity } from "../core/identity.js";
import { toIdentityPort } from "../core/wire-mesh-identity.js";

test("toIdentityPort's deviceId matches identity.ts's own deriveDeviceId", async () => {
  const identity = generateIdentity();
  const port = await toIdentityPort(identity);
  expect(Buffer.from(port.deviceId).toString("hex")).toBe(
    Buffer.from(identity.deviceId).toString("hex"),
  );
});

test("toIdentityPort can sign and verify its own signature", async () => {
  const identity = generateIdentity();
  const port = await toIdentityPort(identity);
  const message = Buffer.from("hello wire-mesh");
  const signature = await port.sign(message);
  const valid = await port.verify(port.identityKey, message, signature);
  expect(valid).toBe(true);
});

test("toIdentityPort's own deriveDeviceId agrees with its own deviceId for its own key", async () => {
  const identity = generateIdentity();
  const port = await toIdentityPort(identity);
  const rederived = await port.deriveDeviceId(port.identityKey["public-key"]);
  expect(Buffer.from(rederived).toString("hex")).toBe(
    Buffer.from(port.deviceId).toString("hex"),
  );
});

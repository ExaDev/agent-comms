/**
 * toIdentityPort must produce the identical device-id identity.ts's own deriveDeviceId already computes for the same keypair -- the two are meant to be the same identity wrapped in two different envelopes, not two independent derivations that happen to usually agree.
 */

import * as assert from "node:assert/strict";
import { test } from "node:test";
import { generateIdentity } from "../core/identity.js";
import { toIdentityPort } from "../core/wire-mesh-identity.js";

void test("toIdentityPort's deviceId matches identity.ts's own deriveDeviceId", async () => {
  const identity = generateIdentity();
  const port = await toIdentityPort(identity);
  assert.equal(
    Buffer.from(port.deviceId).toString("hex"),
    Buffer.from(identity.deviceId).toString("hex"),
  );
});

void test("toIdentityPort can sign and verify its own signature", async () => {
  const identity = generateIdentity();
  const port = await toIdentityPort(identity);
  const message = Buffer.from("hello wire-mesh");
  const signature = await port.sign(message);
  const valid = await port.verify(port.identityKey, message, signature);
  assert.equal(valid, true);
});

void test("toIdentityPort's own deriveDeviceId agrees with its own deviceId for its own key", async () => {
  const identity = generateIdentity();
  const port = await toIdentityPort(identity);
  const rederived = await port.deriveDeviceId(port.identityKey["public-key"]);
  assert.equal(
    Buffer.from(rederived).toString("hex"),
    Buffer.from(port.deviceId).toString("hex"),
  );
});

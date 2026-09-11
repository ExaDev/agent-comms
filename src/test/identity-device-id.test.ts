/**
 * The device-id wire-mesh's own migration will key peer identity on is SHA-256 of the raw public-key bytes -- never the certificate's own DER encoding, which embeds a serial number and validity window that change on every reissue even for an identical key (the same bug this project's certificate-fingerprint peerId already has, and the reason the migration plan treats it as provably unstable). This is purely additive: nothing yet reads identity.deviceId, so this only proves the value itself is correct, not that anything consumes it.
 */

import { createHash, createPublicKey } from "node:crypto";
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { generateIdentity } from "../core/identity.js";

/** Re-derives the raw uncompressed SEC1 point independently of identity.ts's own implementation, via the JWK x/y coordinates every Node public KeyObject can export -- an oracle the test checks identity.ts's own derivation against, not a copy of it. */
function rawPublicKeyFromCertificate(certificatePem: string): Buffer {
  const publicKey = createPublicKey(certificatePem);
  const jwk = publicKey.export({ format: "jwk" });
  if (jwk.x === undefined || jwk.y === undefined) {
    throw new Error("expected an EC JWK with x/y coordinates");
  }
  const UNCOMPRESSED_POINT_TAG = 0x04;
  return Buffer.concat([
    Buffer.from([UNCOMPRESSED_POINT_TAG]),
    Buffer.from(jwk.x, "base64url"),
    Buffer.from(jwk.y, "base64url"),
  ]);
}

const SHA256_BYTE_LENGTH = 32;

void test("deviceId is SHA-256 of the raw public key, independent of the certificate", () => {
  const identity = generateIdentity();
  assert.equal(identity.deviceId.length, SHA256_BYTE_LENGTH);

  const rawPublicKey = rawPublicKeyFromCertificate(identity.certificate);
  const expected = createHash("sha256").update(rawPublicKey).digest();
  assert.equal(Buffer.from(identity.deviceId).equals(expected), true);
});

void test("deviceId differs between two freshly generated identities", () => {
  const a = generateIdentity();
  const b = generateIdentity();
  assert.notEqual(
    Buffer.from(a.deviceId).toString("hex"),
    Buffer.from(b.deviceId).toString("hex"),
  );
});

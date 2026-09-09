/**
 * Regression test: every generated certificate must be loadable by tls.createServer.
 *
 * The hand-rolled DER serial number could begin with a zero byte whenever clearing the sign bit produced 0x00 — a non-minimal INTEGER, which OpenSSL rejects as "illegal padding" when the certificate is loaded. That made tls.createServer fail (even across its retries) for roughly one bridge start in 128. Loading a batch of generated identities catches a reintroduction with high probability while never failing once the encoding is minimal.
 */

import * as tls from "node:tls";
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { generateIdentity } from "../core/identity.js";

// ~90% detection odds against the original 1-in-128 defect per run.
const IDENTITIES_TO_LOAD = 300;

void test("generated certificates are loadable by tls.createServer", () => {
  for (let i = 0; i < IDENTITIES_TO_LOAD; i++) {
    const identity = generateIdentity();
    const server = tls.createServer(
      { key: identity.privateKey, cert: identity.certificate },
      () => {},
    );
    server.close();
    assert.equal(identity.fingerprint.length > 0, true);
  }
});

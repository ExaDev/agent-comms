/**
 * Unit tests for identity.ts — cryptographic identity generation.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { generateIdentity, getCertificateFingerprint } from "../identity.js";

describe("generateIdentity", () => {
  it("returns a valid PeerIdentity with all required fields", () => {
    const identity = generateIdentity();

    assert.ok(identity.privateKey, "private key should be present");
    assert.ok(identity.certificate, "certificate should be present");
    assert.ok(identity.fingerprint, "fingerprint should be present");
  });

  it("produces a valid PEM-encoded private key", () => {
    const { privateKey } = generateIdentity();

    assert.match(
      privateKey,
      /^-----BEGIN PRIVATE KEY-----/,
      "private key should start with PEM header",
    );
    assert.match(
      privateKey,
      /-----END PRIVATE KEY-----\n?$/,
      "private key should end with PEM footer",
    );
  });

  it("produces a valid PEM-encoded certificate", () => {
    const { certificate } = generateIdentity();

    assert.match(
      certificate,
      /^-----BEGIN CERTIFICATE-----/,
      "certificate should start with PEM header",
    );
    assert.match(
      certificate,
      /-----END CERTIFICATE-----\n?$/,
      "certificate should end with PEM footer",
    );
  });

  it("produces a fingerprint that is a 95-character SHA-256 hex string with colons", () => {
    const { fingerprint } = generateIdentity();

    // SHA-256 = 32 bytes = 64 hex chars + 31 colons = 95 chars
    assert.strictEqual(fingerprint.length, 95);
    assert.match(
      fingerprint,
      /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/,
      "fingerprint should be hex pairs separated by colons",
    );
  });

  it("produces a fingerprint that matches Node's own X509Certificate.fingerprint256", () => {
    const { certificate, fingerprint } = generateIdentity();
    const x509 = new X509Certificate(certificate);

    assert.strictEqual(fingerprint, x509.fingerprint256);
  });

  it("produces a certificate that is valid and self-signed", () => {
    const { certificate } = generateIdentity();
    const x509 = new X509Certificate(certificate);

    assert.strictEqual(x509.subject, "CN=agent-comms");
    assert.strictEqual(x509.issuer, "CN=agent-comms");
    assert.ok(
      x509.verify(x509.publicKey),
      "certificate should verify against its own public key",
    );
  });

  it("includes localhost and 127.0.0.1 in Subject Alternative Names", () => {
    const { certificate } = generateIdentity();
    const x509 = new X509Certificate(certificate);

    assert.ok(x509.checkHost("localhost"), "should match DNS:localhost");
    assert.ok(x509.checkIP("127.0.0.1"), "should match IP:127.0.0.1");
  });

  it("produces different fingerprints on successive calls (different keypairs)", () => {
    const a = generateIdentity();
    const b = generateIdentity();

    assert.notStrictEqual(a.fingerprint, b.fingerprint);
    assert.notStrictEqual(a.privateKey, b.privateKey);
    assert.notStrictEqual(a.certificate, b.certificate);
  });
});

describe("getCertificateFingerprint", () => {
  it("is deterministic — same cert always produces same fingerprint", () => {
    const { certificate, fingerprint } = generateIdentity();
    const recomputed = getCertificateFingerprint(certificate);

    assert.strictEqual(recomputed, fingerprint);
  });

  it("produces the same result when called multiple times", () => {
    const { certificate } = generateIdentity();
    const first = getCertificateFingerprint(certificate);
    const second = getCertificateFingerprint(certificate);

    assert.strictEqual(first, second);
  });
});

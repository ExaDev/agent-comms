/**
 * Unit tests for identity.ts — cryptographic identity generation.
 */

import { describe, it, expect } from "vitest";
import { X509Certificate } from "node:crypto";
import {
  generateIdentity,
  getCertificateFingerprint,
  CERTIFICATE_VALIDITY_MS,
} from "../identity.js";

describe("generateIdentity", () => {
  it("returns a valid PeerIdentity with all required fields", () => {
    const identity = generateIdentity();

    expect(identity.privateKey, "private key should be present").toBeTruthy();
    expect(identity.certificate, "certificate should be present").toBeTruthy();
    expect(identity.fingerprint, "fingerprint should be present").toBeTruthy();
  });

  it("produces a valid PEM-encoded private key", () => {
    const { privateKey } = generateIdentity();

    expect(privateKey, "private key should start with PEM header").toMatch(
      /^-----BEGIN PRIVATE KEY-----/,
    );
    expect(privateKey, "private key should end with PEM footer").toMatch(
      /-----END PRIVATE KEY-----\n?$/,
    );
  });

  it("produces a valid PEM-encoded certificate", () => {
    const { certificate } = generateIdentity();

    expect(certificate, "certificate should start with PEM header").toMatch(
      /^-----BEGIN CERTIFICATE-----/,
    );
    expect(certificate, "certificate should end with PEM footer").toMatch(
      /-----END CERTIFICATE-----\n?$/,
    );
  });

  it("produces a fingerprint that is a 95-character SHA-256 hex string with colons", () => {
    const { fingerprint } = generateIdentity();

    // SHA-256 = 32 bytes = 64 hex chars + 31 colons = 95 chars
    expect(fingerprint.length).toBe(95);
    expect(
      fingerprint,
      "fingerprint should be hex pairs separated by colons",
    ).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/);
  });

  it("produces a fingerprint that matches Node's own X509Certificate.fingerprint256", () => {
    const { certificate, fingerprint } = generateIdentity();
    const x509 = new X509Certificate(certificate);

    expect(fingerprint).toBe(x509.fingerprint256);
  });

  it("produces a certificate that is valid and self-signed", () => {
    const { certificate } = generateIdentity();
    const x509 = new X509Certificate(certificate);

    expect(x509.subject).toBe("CN=agent-comms");
    expect(x509.issuer).toBe("CN=agent-comms");
    expect(
      x509.verify(x509.publicKey),
      "certificate should verify against its own public key",
    ).toBeTruthy();
  });

  it("includes localhost and 127.0.0.1 in Subject Alternative Names", () => {
    const { certificate } = generateIdentity();
    const x509 = new X509Certificate(certificate);

    expect(
      x509.checkHost("localhost"),
      "should match DNS:localhost",
    ).toBeTruthy();
    expect(x509.checkIP("127.0.0.1"), "should match IP:127.0.0.1").toBeTruthy();
  });

  it("produces different fingerprints on successive calls (different keypairs)", () => {
    const a = generateIdentity();
    const b = generateIdentity();

    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(a.privateKey).not.toBe(b.privateKey);
    expect(a.certificate).not.toBe(b.certificate);
  });
});

describe("CERTIFICATE_VALIDITY_MS", () => {
  it("is exactly 365 days in milliseconds", () => {
    expect(CERTIFICATE_VALIDITY_MS).toBe(365 * 24 * 60 * 60 * 1000);
  });
});

describe("getCertificateFingerprint", () => {
  it("is deterministic — same cert always produces same fingerprint", () => {
    const { certificate, fingerprint } = generateIdentity();
    const recomputed = getCertificateFingerprint(certificate);

    expect(recomputed).toBe(fingerprint);
  });

  it("produces the same result when called multiple times", () => {
    const { certificate } = generateIdentity();
    const first = getCertificateFingerprint(certificate);
    const second = getCertificateFingerprint(certificate);

    expect(first).toBe(second);
  });
});

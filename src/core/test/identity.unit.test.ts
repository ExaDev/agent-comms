/**
 * Unit tests for identity.ts — cryptographic identity generation.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { X509Certificate, generateKeyPairSync } from "node:crypto";
import {
  generateIdentity,
  getCertificateFingerprint,
  CERTIFICATE_VALIDITY_MS,
  rawPublicKeyFromPrivateKey,
} from "../identity.js";

/** PEM's own base64 body wrap width (RFC 7468). */
const PEM_LINE_LENGTH = 64;
/** SHA-256 = 32 bytes = 64 hex chars + 31 colons = 95 chars. */
const SHA256_COLON_FINGERPRINT_LENGTH = 95;
/** The ASN.1 context-specific constructor tag [0] that wraps an X.509 certificate's version field. */
const X509_VERSION_CONTEXT_TAG = 0xa0;
/** Length in bytes of the version field's own DER-encoded INTEGER (tag + length + value). */
const X509_VERSION_FIELD_LENGTH = 0x03;
/** DER BOOLEAN TRUE. */
const DER_BOOLEAN_TRUE = 0xff;
/** How many identities to sample when checking serial numbers aren't collapsing onto one leading byte. */
const SERIAL_NUMBER_SAMPLE_COUNT = 20;
/** Days in the certificate validity period. */
const CERTIFICATE_VALIDITY_DAYS = 365;
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;

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

  it("wraps the certificate's base64 body at 64 characters per line", () => {
    const { certificate } = generateIdentity();
    const bodyLines = certificate
      .split("\n")
      .filter(
        (line) =>
          line.length > 0 &&
          line !== "-----BEGIN CERTIFICATE-----" &&
          line !== "-----END CERTIFICATE-----",
      );

    expect(bodyLines.length).toBeGreaterThan(1);
    for (const line of bodyLines.slice(0, -1)) {
      expect(line.length).toBe(PEM_LINE_LENGTH);
    }
    expect(bodyLines.at(-1)?.length).toBeLessThanOrEqual(PEM_LINE_LENGTH);
  });

  it("produces a fingerprint that is a 95-character SHA-256 hex string with colons", () => {
    const { fingerprint } = generateIdentity();

    expect(fingerprint.length).toBe(SHA256_COLON_FINGERPRINT_LENGTH);
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

  it("encodes the certificate as X.509 v3 (context tag [0] EXPLICIT INTEGER 2)", () => {
    // v3 is required for the Subject Alternative Name / Basic Constraints extensions to be legal at all -- a v1 certificate carrying extensions is malformed, so the version tag is load-bearing even though nothing else in this file reads it back.
    const { certificate } = generateIdentity();
    const x509 = new X509Certificate(certificate);

    const versionField = Buffer.from([
      X509_VERSION_CONTEXT_TAG,
      X509_VERSION_FIELD_LENGTH,
      0x02,
      0x01,
      0x02,
    ]);
    expect(x509.raw.indexOf(versionField)).toBeGreaterThanOrEqual(0);
  });

  it("marks the Basic Constraints extension critical (DER BOOLEAN TRUE)", () => {
    // RFC 5280 requires Basic Constraints to be marked critical; a non-critical CA:FALSE constraint is a spec violation that some strict X.509 validators reject outright, even though tls.createServer tolerates it.
    const { certificate } = generateIdentity();
    const x509 = new X509Certificate(certificate);
    const criticalTrue = Buffer.from([0x01, 0x01, DER_BOOLEAN_TRUE]);

    expect(x509.raw.indexOf(criticalTrue)).toBeGreaterThanOrEqual(0);
  });

  it("does not systematically force the serial number's leading byte to a fixed value", () => {
    const firstBytes = new Set<string>();
    for (let i = 0; i < SERIAL_NUMBER_SAMPLE_COUNT; i++) {
      const { certificate } = generateIdentity();
      const x509 = new X509Certificate(certificate);
      firstBytes.add(x509.serialNumber.slice(0, 2));
    }

    expect(
      firstBytes.size,
      "serial numbers should vary across identities, not collapse onto one leading byte",
    ).toBeGreaterThan(1);
  });

  describe("certificate validity window", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("encodes notBefore/notAfter as exact zero-padded UTCTime, CERTIFICATE_VALIDITY_MS apart", () => {
      // 2005-03-05T07:08:09Z: every date component below 10 (year%100, month, day, minute) so a missing zero-pad or an off-by-one in month arithmetic shifts the parsed date.
      const fixedYear = 2005;
      const fixedMonthIndex = 2; // March (Date.UTC months are 0-indexed)
      const fixedDay = 5;
      const fixedHour = 7;
      const fixedMinute = 8;
      const fixedSecond = 9;
      const fixedNow = new Date(
        Date.UTC(
          fixedYear,
          fixedMonthIndex,
          fixedDay,
          fixedHour,
          fixedMinute,
          fixedSecond,
        ),
      );
      vi.useFakeTimers();
      vi.setSystemTime(fixedNow);

      const { certificate } = generateIdentity();
      const x509 = new X509Certificate(certificate);

      expect(x509.validFromDate.toISOString()).toBe(fixedNow.toISOString());
      expect(x509.validToDate.getTime() - x509.validFromDate.getTime()).toBe(
        CERTIFICATE_VALIDITY_MS,
      );
    });
  });
});

describe("CERTIFICATE_VALIDITY_MS", () => {
  it("is exactly 365 days in milliseconds", () => {
    expect(CERTIFICATE_VALIDITY_MS).toBe(
      CERTIFICATE_VALIDITY_DAYS *
        HOURS_PER_DAY *
        MINUTES_PER_HOUR *
        SECONDS_PER_MINUTE *
        MS_PER_SECOND,
    );
  });
});

describe("rawPublicKeyFromPrivateKey", () => {
  it("throws for a private key whose JWK export has no EC x/y coordinates", () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });

    expect(() => rawPublicKeyFromPrivateKey(privateKey)).toThrow(
      "expected an EC JWK with x/y coordinates",
    );
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

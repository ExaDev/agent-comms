/**
 * Cryptographic identity generation for mesh peers.
 *
 * Each MeshStore instance generates an ECDSA P-256 keypair and a self-signed
 * X.509 certificate on first run. The peer ID is derived from the SHA-256
 * fingerprint of the certificate (DER-encoded, hex with colons), replacing
 * the previous nanoid(8) approach.
 *
 * Key material stays in memory only — never written to disk.
 */

import {
  createHash,
  createPublicKey,
  createSign,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PeerIdentity {
  /** PEM-encoded PKCS#8 private key. */
  privateKey: string;
  /** PEM-encoded self-signed X.509 certificate. */
  certificate: string;
  /** SHA-256 fingerprint of the certificate (DER), hex-encoded with colons. */
  fingerprint: string;
}

// ─── ASN.1 DER helpers ─────────────────────────────────────────────────────

/** Encode a DER length field. */
function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  if (length < 0x100) return Buffer.from([0x81, length]);
  return Buffer.from([0x82, (length >> 8) & 0xff, length & 0xff]);
}

/** Wrap content bytes in a DER tag. */
function derWrap(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

/** DER SEQUENCE. */
function derSequence(...items: Buffer[]): Buffer {
  return derWrap(0x30, Buffer.concat(items));
}

/** DER SET. */
function derSet(...items: Buffer[]): Buffer {
  return derWrap(0x31, Buffer.concat(items));
}

/** DER OBJECT IDENTIFIER from dotted-decimal string. */
function derOID(oid: string): Buffer {
  const parts = oid.split(".").map(Number);
  const first = parts[0];
  const second = parts[1];
  if (first === undefined || second === undefined) {
    throw new Error(`Invalid OID: ${oid}`);
  }
  const bytes: number[] = [40 * first + second];
  for (let i = 2; i < parts.length; i++) {
    let value = parts[i];
    if (value === undefined) continue;
    if (value < 128) {
      bytes.push(value);
      continue;
    }
    const encoded: number[] = [];
    encoded.push(value & 0x7f);
    value >>= 7;
    while (value > 0) {
      encoded.push(0x80 | (value & 0x7f));
      value >>= 7;
    }
    bytes.push(...encoded.reverse());
  }
  return derWrap(0x06, Buffer.from(bytes));
}

/** DER UTF8String. */
function derUTF8String(value: string): Buffer {
  return derWrap(0x0c, Buffer.from(value, "utf8"));
}

/** DER INTEGER from a raw byte buffer (adds leading zero if high bit set). */
function derIntegerBytes(value: Buffer): Buffer {
  const firstByte = value[0];
  if (firstByte === undefined || firstByte & 0x80) {
    return derWrap(0x02, Buffer.concat([Buffer.from([0x00]), value]));
  }
  return derWrap(0x02, value);
}

/** DER BIT STRING (with zero unused-bits prefix). */
function derBitString(content: Buffer): Buffer {
  return derWrap(0x03, Buffer.concat([Buffer.from([0x00]), content]));
}

/** DER OCTET STRING. */
function derOctetString(content: Buffer): Buffer {
  return derWrap(0x04, content);
}

/** DER BOOLEAN. */
function derBoolean(value: boolean): Buffer {
  return derWrap(0x01, Buffer.from([value ? 0xff : 0x00]));
}

/** DER UTCTime from a Date. Format: YYMMDDHHMMSSZ */
function derUTCTime(date: Date): Buffer {
  const str = [
    String(date.getUTCFullYear() % 100).padStart(2, "0"),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
    String(date.getUTCHours()).padStart(2, "0"),
    String(date.getUTCMinutes()).padStart(2, "0"),
    String(date.getUTCSeconds()).padStart(2, "0"),
    "Z",
  ].join("");
  return derWrap(0x17, Buffer.from(str, "ascii"));
}

// ─── OID constants ──────────────────────────────────────────────────────────

/** ECDSA with SHA-256 signature algorithm. */
const OID_ECDSA_WITH_SHA256 = "1.2.840.10045.4.3.2";
/** Common Name attribute. */
const OID_CN = "2.5.4.3";
/** Subject Key Identifier extension. */
const OID_SKI = "2.5.29.14";
/** Subject Alternative Name extension. */
const OID_SAN = "2.5.29.17";
/** Basic Constraints extension. */
const OID_BASIC_CONSTRAINTS = "2.5.29.19";

// ─── Certificate building ───────────────────────────────────────────────────

/**
 * Build a self-signed X.509 v3 certificate in DER format.
 *
 * Structure (RFC 5280 §4.1):
 *   Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue }
 */
function buildCertificateDer(
  tbsCertificate: Buffer,
  signatureAlgorithm: Buffer,
  signature: Buffer,
): Buffer {
  return derSequence(tbsCertificate, signatureAlgorithm, derBitString(signature));
}

/**
 * Build the TBSCertificate DER structure.
 *
 * Structure (RFC 5280 §4.1.2):
 *   version [0] EXPLICIT INTEGER (v3 = 2),
 *   serialNumber INTEGER,
 *   signature AlgorithmIdentifier,
 *   issuer Name,
 *   validity { notBefore, notAfter },
 *   subject Name,
 *   subjectPublicKeyInfo SubjectPublicKeyInfo,
 *   extensions [3] EXPLICIT Extensions OPTIONAL
 */
function buildTbsCertificate(
  serial: Buffer,
  signatureAlgorithm: Buffer,
  issuerSubject: Buffer,
  validity: Buffer,
  subjectPublicKeyInfoDer: Buffer,
  extensions: Buffer,
): Buffer {
  // version: [0] EXPLICIT { INTEGER 2 } → a0 03 02 01 02
  const version = derWrap(0xa0, derIntegerBytes(Buffer.from([2])));

  return derSequence(
    version,
    derIntegerBytes(serial),
    signatureAlgorithm,
    issuerSubject, // issuer
    validity,
    issuerSubject, // subject (same as issuer for self-signed)
    subjectPublicKeyInfoDer,
    derWrap(0xa3, derSequence(extensions)), // [3] EXPLICIT
  );
}

/**
 * Build the X.509v3 extensions.
 *
 * Includes:
 * - Subject Key Identifier (SHA-1 hash of the public key DER)
 * - Subject Alternative Name (DNS:localhost, IP:127.0.0.1)
 * - Basic Constraints (CA:FALSE, critical)
 */
function buildExtensions(publicKeyDer: Buffer): Buffer {
  // Subject Key Identifier
  const ski = createHash("sha1").update(publicKeyDer).digest();
  const skiExtension = derSequence(derOID(OID_SKI), derOctetString(derOctetString(ski)));

  // Subject Alternative Name
  const sanValue = derSequence(
    derWrap(0x82, Buffer.from("localhost", "ascii")), // dNSName
    derWrap(0x87, Buffer.from([127, 0, 0, 1])), // iPAddress
  );
  const sanExtension = derSequence(derOID(OID_SAN), derOctetString(sanValue));

  // Basic Constraints (CA:FALSE, critical)
  const bcExtension = derSequence(
    derOID(OID_BASIC_CONSTRAINTS),
    derBoolean(true), // critical
    derOctetString(derSequence()), // empty sequence = CA:FALSE
  );

  return Buffer.concat([skiExtension, sanExtension, bcExtension]);
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Generate a fresh cryptographic identity: ECDSA P-256 keypair and self-signed
 * X.509 certificate. The fingerprint of the certificate serves as the peer ID.
 *
 * Key material stays in memory only — never written to disk.
 */
export function generateIdentity(): PeerIdentity {
  // When encoding options are specified, generateKeyPairSync returns
  // { publicKey: string, privateKey: string } in PEM format.
  const keyPair = generateKeyPairSync("ec", {
    namedCurve: "P-256",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const publicKeyDer = createPublicKey(keyPair.publicKey).export({
    type: "spki",
    format: "der",
  });

  // Random serial number (20 bytes). Clear the high bit to ensure positive.
  const serialBytes = createHash("sha256")
    .update(randomBytes(16))
    .digest()
    .subarray(0, 20);
  const serial = Buffer.from(serialBytes);
  const firstSerialByte = serial[0];
  if (firstSerialByte !== undefined) serial[0] = firstSerialByte & 0x7f;

  // Validity period: now through 365 days from now
  const now = new Date();
  const expires = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

  // Subject/Issuer Name: SEQUENCE { SET { SEQUENCE { OID, value } } }
  const subject = derSequence(
    derSet(derSequence(derOID(OID_CN), derUTF8String("agent-comms"))),
  );

  // Signature algorithm: ecdsa-with-SHA256
  const sigAlgSeq = derSequence(derOID(OID_ECDSA_WITH_SHA256));

  // Validity
  const validity = derSequence(derUTCTime(now), derUTCTime(expires));

  // Extensions
  const extensions = buildExtensions(publicKeyDer);

  // TBSCertificate
  const tbsCert = buildTbsCertificate(
    serial,
    sigAlgSeq,
    subject,
    validity,
    publicKeyDer,
    extensions,
  );

  // Sign the TBSCertificate
  const signer = createSign("SHA256");
  signer.update(tbsCert);
  const signature = signer.sign(keyPair.privateKey);

  // Assemble the full certificate
  const certDer = buildCertificateDer(tbsCert, sigAlgSeq, signature);

  // PEM-encode
  const certificate = derToCertificatePem(certDer);

  return {
    privateKey: keyPair.privateKey,
    certificate,
    fingerprint: getCertificateFingerprint(certificate),
  };
}

/**
 * Compute the SHA-256 fingerprint of a PEM-encoded certificate.
 * Returns hex-encoded with colon separators (standard format): "AB:CD:EF:..."
 */
export function getCertificateFingerprint(certificate: string): string {
  const der = pemToDer(certificate);
  const hex = createHash("sha256")
    .update(der)
    .digest("hex")
    .toUpperCase();
  const matched = hex.match(/.{2}/g);
  if (matched === null) return "";
  return matched.join(":");
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Decode a PEM-encoded certificate to raw DER bytes. */
function pemToDer(pem: string): Buffer {
  const b64 = pem
    .replace(/-----BEGIN CERTIFICATE-----/, "")
    .replace(/-----END CERTIFICATE-----/, "")
    .replace(/\s/g, "");
  return Buffer.from(b64, "base64");
}

/** Encode DER bytes as a PEM certificate string. */
function derToCertificatePem(der: Buffer): string {
  const b64 = der.toString("base64").match(/.{1,64}/g);
  const lines = b64 ?? [];
  return [
    "-----BEGIN CERTIFICATE-----",
    ...lines,
    "-----END CERTIFICATE-----",
    "",
  ].join("\n");
}

/**
 * Cryptographic identity generation for mesh peers.
 *
 * Each MeshStore instance generates an ECDSA P-256 keypair and a self-signed
 * X.509 certificate on first run. The peer ID is derived from the SHA-256
 * fingerprint of the certificate (DER-encoded, hex with colons), replacing
 * the previous nanoid(8) approach.
 *
 * Key material is generated in memory; bridges that need a stable identity
 * across restarts persist it through identity-store.ts, which keeps the
 * fingerprint (and therefore the peer/agent ID) stable.
 */

import {
  createHash,
  createPublicKey,
  createSign,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";

/** The uncompressed SEC1 point tag byte (RFC 5480 §2.2): 0x04 marks what follows as raw X||Y, never compressed or hybrid encoding. */
const UNCOMPRESSED_POINT_TAG = 0x04;

/** Days in the certificate validity period. */
const CERTIFICATE_VALIDITY_DAYS = 365;
/** Hours per day, used to convert the certificate validity period to milliseconds. */
const HOURS_PER_DAY = 24;
/** Minutes per hour, used to convert the certificate validity period to milliseconds. */
const MINUTES_PER_HOUR = 60;
/** Seconds per minute, used to convert the certificate validity period to milliseconds. */
const SECONDS_PER_MINUTE = 60;
/** Milliseconds per second, used to convert the certificate validity period to milliseconds. */
const MS_PER_SECOND = 1000;

// ─── Types ──────────────────────────────────────────────────────────────────

/** Self-signed certificate validity. Exported so identity persistence can derive its renewal margin. */
export const CERTIFICATE_VALIDITY_MS =
  CERTIFICATE_VALIDITY_DAYS *
  HOURS_PER_DAY *
  MINUTES_PER_HOUR *
  SECONDS_PER_MINUTE *
  MS_PER_SECOND;

export interface PeerIdentity {
  /** PEM-encoded PKCS#8 private key. */
  privateKey: string;
  /** PEM-encoded self-signed X.509 certificate. */
  certificate: string;
  /** SHA-256 fingerprint of the certificate (DER), hex-encoded with colons. */
  fingerprint: string;
  /**
   * SHA-256 of the raw, uncompressed SEC1 public-key point -- wire-mesh's own device-id derivation (never the certificate's DER encoding, which embeds a serial number and validity window that change on every reissue even for an identical key; this is the exact instability fingerprint already has). Additive: nothing in this codebase reads it yet. `fingerprint` remains what MeshStore.peerId is set to until the substrate migration cuts over to this field instead.
   */
  deviceId: Uint8Array;
}

// ─── ASN.1 DER helpers ─────────────────────────────────────────────────────

/** The high (0x80) bit of a byte -- the DER long-form length marker, the OID base-128 continuation bit, and the DER INTEGER sign bit all key off this same bit. */
const HIGH_BIT = 0x80;
/** Mask for the low 7 bits of a byte -- the payload bits in a DER long-form length prefix and in a base-128 OID subidentifier byte. */
const LOW_7_BITS_MASK = 0x7f;
/** Bits in a byte, used to split a DER length into its high and low bytes. */
const BITS_PER_BYTE = 8;
/** Mask for a single byte. */
const BYTE_MASK = 0xff;
/** Smallest length that needs a second DER long-form length byte (i.e. no longer fits in one byte). */
const DER_LENGTH_TWO_BYTE_MIN = 0x100;
/** DER long-form length prefix: one length byte follows. */
const DER_LENGTH_PREFIX_1_BYTE = 0x81;
/** DER long-form length prefix: two length bytes follow. */
const DER_LENGTH_PREFIX_2_BYTES = 0x82;
/** ASN.1 universal SEQUENCE tag. */
const DER_TAG_SEQUENCE = 0x30;
/** ASN.1 universal SET tag. */
const DER_TAG_SET = 0x31;

/** Encode a DER length field. */
function derLength(length: number): Buffer {
  if (length < HIGH_BIT) return Buffer.from([length]);
  if (length < DER_LENGTH_TWO_BYTE_MIN)
    return Buffer.from([DER_LENGTH_PREFIX_1_BYTE, length]);
  return Buffer.from([
    DER_LENGTH_PREFIX_2_BYTES,
    (length >> BITS_PER_BYTE) & BYTE_MASK,
    length & BYTE_MASK,
  ]);
}

/** Wrap content bytes in a DER tag. */
function derWrap(tag: number, content: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([tag]),
    derLength(content.length),
    content,
  ]);
}

/** DER SEQUENCE. */
function derSequence(...items: readonly Buffer[]): Buffer {
  return derWrap(DER_TAG_SEQUENCE, Buffer.concat(items));
}

/** DER SET. */
function derSet(...items: readonly Buffer[]): Buffer {
  return derWrap(DER_TAG_SET, Buffer.concat(items));
}

/** X.690 rule for encoding an OID's first two arcs into a single byte: 40 * first-arc + second-arc. */
const OID_FIRST_ARC_MULTIPLIER = 40;
/** Bits carried per byte in an OID subidentifier's base-128 (7-bit group) varint encoding. */
const BITS_PER_OID_GROUP = 7;
/** ASN.1 universal OBJECT IDENTIFIER tag. */
const DER_TAG_OID = 0x06;
/** ASN.1 universal UTF8String tag. */
const DER_TAG_UTF8_STRING = 0x0c;
/** ASN.1 universal INTEGER tag. */
const DER_TAG_INTEGER = 0x02;
/** Leading zero byte prepended to a DER INTEGER whose first content byte has its sign bit set, so it is not misread as negative. */
const DER_INTEGER_PADDING_BYTE = 0x00;
/** ASN.1 universal BIT STRING tag. */
const DER_TAG_BIT_STRING = 0x03;
/** BIT STRING unused-bits prefix: this codec never leaves trailing unused bits. */
const DER_BIT_STRING_NO_UNUSED_BITS = 0x00;
/** ASN.1 universal OCTET STRING tag. */
const DER_TAG_OCTET_STRING = 0x04;
/** ASN.1 universal BOOLEAN tag. */
const DER_TAG_BOOLEAN = 0x01;
/** DER encodes a BOOLEAN true as an all-ones byte (X.690 §8.2.2 in DER mode). */
const DER_BOOLEAN_TRUE_BYTE = 0xff;
/** DER encodes a BOOLEAN false as an all-zeros byte. */
const DER_BOOLEAN_FALSE_BYTE = 0x00;
/** ASN.1 universal UTCTime tag. */
const DER_TAG_UTCTIME = 0x17;
/** UTCTime encodes the year as two digits, so the full year is taken modulo this. */
const UTCTIME_YEAR_MODULUS = 100;

/** DER OBJECT IDENTIFIER from dotted-decimal string. */
function derOID(oid: string): Buffer {
  const parts = oid.split(".").map(Number);
  const first = parts[0];
  const second = parts[1];
  if (first === undefined || second === undefined) {
    throw new Error(`Invalid OID: ${oid}`);
  }
  const bytes: number[] = [OID_FIRST_ARC_MULTIPLIER * first + second];
  for (let i = 2; i < parts.length; i++) {
    let value = parts[i];
    if (value === undefined) continue;
    if (value < HIGH_BIT) {
      bytes.push(value);
      continue;
    }
    const encoded: number[] = [];
    encoded.push(value & LOW_7_BITS_MASK);
    value >>= BITS_PER_OID_GROUP;
    while (value > 0) {
      encoded.push(HIGH_BIT | (value & LOW_7_BITS_MASK));
      value >>= BITS_PER_OID_GROUP;
    }
    bytes.push(...encoded.reverse());
  }
  return derWrap(DER_TAG_OID, Buffer.from(bytes));
}

/** DER UTF8String. */
function derUTF8String(value: string): Buffer {
  return derWrap(DER_TAG_UTF8_STRING, Buffer.from(value, "utf8"));
}

/** DER INTEGER from a raw byte buffer (adds leading zero if high bit set). */
function derIntegerBytes(value: Buffer): Buffer {
  const firstByte = value[0];
  if (firstByte === undefined || firstByte & HIGH_BIT) {
    return derWrap(
      DER_TAG_INTEGER,
      Buffer.concat([Buffer.from([DER_INTEGER_PADDING_BYTE]), value]),
    );
  }
  return derWrap(DER_TAG_INTEGER, value);
}

/** DER BIT STRING (with zero unused-bits prefix). */
function derBitString(content: Buffer): Buffer {
  return derWrap(
    DER_TAG_BIT_STRING,
    Buffer.concat([Buffer.from([DER_BIT_STRING_NO_UNUSED_BITS]), content]),
  );
}

/** DER OCTET STRING. */
function derOctetString(content: Buffer): Buffer {
  return derWrap(DER_TAG_OCTET_STRING, content);
}

/** DER BOOLEAN. */
function derBoolean(value: boolean): Buffer {
  return derWrap(
    DER_TAG_BOOLEAN,
    Buffer.from([value ? DER_BOOLEAN_TRUE_BYTE : DER_BOOLEAN_FALSE_BYTE]),
  );
}

/** DER UTCTime from a Date. Format: YYMMDDHHMMSSZ */
function derUTCTime(date: Readonly<Date>): Buffer {
  const str = [
    String(date.getUTCFullYear() % UTCTIME_YEAR_MODULUS).padStart(2, "0"),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
    String(date.getUTCHours()).padStart(2, "0"),
    String(date.getUTCMinutes()).padStart(2, "0"),
    String(date.getUTCSeconds()).padStart(2, "0"),
    "Z",
  ].join("");
  return derWrap(DER_TAG_UTCTIME, Buffer.from(str, "ascii"));
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

/** X.509 TBSCertificate `version` field's context-specific tag: `[0] EXPLICIT`. */
const CONTEXT_TAG_VERSION = 0xa0;
/** X.509 TBSCertificate `extensions` field's context-specific tag: `[3] EXPLICIT`. */
const CONTEXT_TAG_EXTENSIONS = 0xa3;
/** SAN GeneralName `dNSName` choice's context-specific tag: `[2] IMPLICIT`. */
const SAN_TAG_DNS_NAME = 0x82;
/** SAN GeneralName `iPAddress` choice's context-specific tag: `[7] IMPLICIT`. */
const SAN_TAG_IP_ADDRESS = 0x87;
/** First octet of the IPv4 loopback address (127.0.0.1) encoded into the SAN `iPAddress` extension. */
const LOCALHOST_IPV4_FIRST_OCTET = 127;
/** Random bytes hashed to seed the certificate serial number. */
const SERIAL_SEED_BYTES = 16;
/** Certificate serial number length in bytes (RFC 5280 recommends no more than 20 octets). */
const SERIAL_LENGTH_BYTES = 20;

// ─── Certificate building ───────────────────────────────────────────────────

/**
 * Build a self-signed X.509 v3 certificate in DER format.
 *
 * Structure (RFC 5280 §4.1): `Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue }`
 */
function buildCertificateDer(
  tbsCertificate: Buffer,
  signatureAlgorithm: Buffer,
  signature: Buffer,
): Buffer {
  return derSequence(
    tbsCertificate,
    signatureAlgorithm,
    derBitString(signature),
  );
}

/**
 * Build the TBSCertificate DER structure.
 *
 * Structure (RFC 5280 §4.1.2): `version [0] EXPLICIT INTEGER (v3 = 2), serialNumber INTEGER, signature AlgorithmIdentifier, issuer Name, validity { notBefore, notAfter }, subject Name, subjectPublicKeyInfo SubjectPublicKeyInfo, extensions [3] EXPLICIT Extensions OPTIONAL`
 */
function buildTbsCertificate(options: {
  serial: Buffer;
  signatureAlgorithm: Buffer;
  issuerSubject: Buffer;
  validity: Buffer;
  subjectPublicKeyInfoDer: Buffer;
  extensions: Buffer;
}): Buffer {
  const {
    serial,
    signatureAlgorithm,
    issuerSubject,
    validity,
    subjectPublicKeyInfoDer,
    extensions,
  } = options;
  // version: [0] EXPLICIT { INTEGER 2 } → a0 03 02 01 02
  const version = derWrap(
    CONTEXT_TAG_VERSION,
    derIntegerBytes(Buffer.from([2])),
  );

  return derSequence(
    version,
    derIntegerBytes(serial),
    signatureAlgorithm,
    issuerSubject, // issuer
    validity,
    issuerSubject, // subject (same as issuer for self-signed)
    subjectPublicKeyInfoDer,
    derWrap(CONTEXT_TAG_EXTENSIONS, derSequence(extensions)), // [3] EXPLICIT
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
  const skiExtension = derSequence(
    derOID(OID_SKI),
    derOctetString(derOctetString(ski)),
  );

  // Subject Alternative Name
  const sanValue = derSequence(
    derWrap(SAN_TAG_DNS_NAME, Buffer.from("localhost", "ascii")), // dNSName
    derWrap(
      SAN_TAG_IP_ADDRESS,
      Buffer.from([LOCALHOST_IPV4_FIRST_OCTET, 0, 0, 1]),
    ), // iPAddress
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
 * Generate a fresh cryptographic identity: ECDSA P-256 keypair and self-signed X.509 certificate. The fingerprint of the certificate serves as the peer ID.
 *
 * Key material is generated in memory; bridges that need a stable identity across restarts persist it through identity-store.ts, which keeps the fingerprint (and therefore the peer/agent ID) stable.
 */
export function generateIdentity(): PeerIdentity {
  // When encoding options are specified, generateKeyPairSync returns { publicKey: string, privateKey: string } in PEM format.
  const keyPair = generateKeyPairSync("ec", {
    namedCurve: "P-256",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  return certifyKeyPair(keyPair.privateKey);
}

/**
 * Issue a fresh self-signed X.509 certificate for an already-existing EC private key, rather than generating a new key pair -- what a certificate renewal must call instead of `generateIdentity()`, since device-id is derived from the public key, not the certificate: reusing the same key pair across a re-sign is what keeps device-id stable across renewal.
 */
export function certifyKeyPair(privateKeyPem: string): PeerIdentity {
  const publicKeyDer = createPublicKey(privateKeyPem).export({
    type: "spki",
    format: "der",
  });

  // Random serial number (SERIAL_LENGTH_BYTES bytes). Clear the high bit to ensure positive.
  const serialBytes = createHash("sha256")
    .update(randomBytes(SERIAL_SEED_BYTES))
    .digest()
    .subarray(0, SERIAL_LENGTH_BYTES);
  const serial = Buffer.from(serialBytes);
  const firstSerialByte = serial[0];
  if (firstSerialByte !== undefined)
    serial[0] = firstSerialByte & LOW_7_BITS_MASK;
  // DER INTEGERs are minimally encoded: a leading zero byte is only legal when the following byte's high bit is set. Clearing the sign bit above can leave 0x00 here, which OpenSSL rejects as illegal padding when the certificate is loaded (tls.createServer then fails despite retries), so pin it to a minimal non-zero value.
  if (serial[0] === 0) serial[0] = 1;

  // Validity period: now through CERTIFICATE_VALIDITY_MS from now
  const now = new Date();
  const expires = new Date(now.getTime() + CERTIFICATE_VALIDITY_MS);

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
  const tbsCert = buildTbsCertificate({
    serial,
    signatureAlgorithm: sigAlgSeq,
    issuerSubject: subject,
    validity,
    subjectPublicKeyInfoDer: publicKeyDer,
    extensions,
  });

  // Sign the TBSCertificate
  const signer = createSign("SHA256");
  signer.update(tbsCert);
  const signature = signer.sign(privateKeyPem);

  // Assemble the full certificate
  const certDer = buildCertificateDer(tbsCert, sigAlgSeq, signature);

  // PEM-encode
  const certificate = derToCertificatePem(certDer);

  return {
    privateKey: privateKeyPem,
    certificate,
    fingerprint: getCertificateFingerprint(certificate),
    deviceId: deriveDeviceId(privateKeyPem),
  };
}

/**
 * Compute the SHA-256 fingerprint of a PEM-encoded certificate.
 * Returns hex-encoded with colon separators (standard format): "AB:CD:EF:..."
 */
export function getCertificateFingerprint(certificate: string): string {
  const der = pemToDer(certificate);
  return fingerprintDer(der);
}

/**
 * Compute the SHA-256 fingerprint of a certificate already presented as raw DER bytes — the shape `tls.TLSSocket.getPeerCertificate().raw` returns for a live connection. Same hashing and formatting as `getCertificateFingerprint`, so a value pinned from a PEM certificate compares equal to the fingerprint of that same certificate presented live over a socket.
 */
export function fingerprintDer(der: Buffer): string {
  const hex = createHash("sha256").update(der).digest("hex").toUpperCase();
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

/** The raw, uncompressed SEC1 public-key point (0x04 || X || Y) for a PEM-encoded EC private key -- what wire-mesh's own device-id and identity-key.public-key are both derived from, never a certificate's DER encoding. */
export function rawPublicKeyFromPrivateKey(privateKeyPem: string): Uint8Array {
  const publicKey = createPublicKey(privateKeyPem);
  const jwk = publicKey.export({ format: "jwk" });
  if (jwk.x === undefined || jwk.y === undefined) {
    throw new Error("expected an EC JWK with x/y coordinates");
  }
  return Buffer.concat([
    Buffer.from([UNCOMPRESSED_POINT_TAG]),
    Buffer.from(jwk.x, "base64url"),
    Buffer.from(jwk.y, "base64url"),
  ]);
}

/** Derives wire-mesh's own device-id (SHA-256 of the raw, uncompressed SEC1 public-key point) from a PEM-encoded EC private key. */
export function deriveDeviceId(privateKeyPem: string): Uint8Array {
  return createHash("sha256")
    .update(rawPublicKeyFromPrivateKey(privateKeyPem))
    .digest();
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

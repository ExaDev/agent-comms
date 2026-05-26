/**
 * VAPID key generation for Web Push (RFC 8292).
 *
 * Generates a P-256 EC key pair once per process lifetime and caches it
 * in memory. The public key is shared with the PWA client so it can
 * create push subscriptions; the private key signs push requests.
 */

import * as crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VapidKeys {
  /** Base64url-encoded uncompressed P-256 public key (65 bytes). */
  publicKey: string;
  /** Base64url-encoded P-256 private key (32 bytes). */
  privateKey: string;
}

// ---------------------------------------------------------------------------
// Cached singleton
// ---------------------------------------------------------------------------

let cachedKeys: VapidKeys | undefined;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Generate or return cached VAPID keys.
 *
 * Uses Node.js `crypto.generateKeyPairSync` with P-256, extracts the
 * raw 65-byte uncompressed public point and the 32-byte private scalar,
 * and base64url-encodes both per RFC 8291.
 */
export function generateVapidKeys(): VapidKeys {
  if (cachedKeys) return cachedKeys;

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });

  // Export public key as raw DER, extract the 65-byte uncompressed point.
  // SPKI DER for P-256 has a 26-byte header before the 65-byte point.
  const pubDer = publicKey.export({ type: "spki", format: "der" });
  const publicKeyBuffer = pubDer.subarray(pubDer.length - 65);

  // Export private key as PKCS8 DER, extract the 32-byte private scalar.
  // PKCS8 DER for P-256 has a 39-byte header before the 32-byte scalar.
  // The scalar is the last 32 bytes (after the leading zero pad byte).
  const privDer = privateKey.export({ type: "pkcs8", format: "der" });
  const privateKeyBuffer = privDer.subarray(privDer.length - 32);

  cachedKeys = {
    publicKey: base64url(publicKeyBuffer),
    privateKey: base64url(privateKeyBuffer),
  };

  return cachedKeys;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function base64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

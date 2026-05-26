/**
 * Web Push encryption and VAPID JWT signing (RFC 8291 + RFC 8292).
 *
 * Implements the Web Push protocol using only Node.js built-in `crypto`
 * and `https` — no external dependencies.
 *
 * Encryption flow (RFC 8291):
 *   1. Derive a shared ECDH secret from the subscription's p256dh key
 *   2. HKDF-derive the encryption key and nonce from the shared secret + auth
 *   3. Encrypt the payload with AES-128-GCM
 *   4. Prepend the sender's public key (65 bytes) to the ciphertext
 *
 * VAPID signing (RFC 8292):
 *   1. Build a JWT with { sub, exp, aud } claims
 *   2. Sign with ES256 (ECDSA + P-256 + SHA-256)
 *   3. Append the public key and token to the Crypto-Key header
 */

import * as crypto from "node:crypto";
import * as https from "node:https";
import * as http from "node:http";
import { URL } from "node:url";

import type { VapidKeys } from "./vapid.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushPayload {
  title: string;
  body: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const CONTENT_ENCODING = "aes128gcm";
const KEY_LENGTH = 16;
const NONCE_LENGTH = 12;
const SALT_LENGTH = 16;
const MAX_PAYLOAD_SIZE = 4078;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send a Web Push notification.
 *
 * Encrypts the payload per RFC 8291, signs with VAPID per RFC 8292,
 * and POSTs to the push service endpoint.
 */
export async function sendWebPush(
  subscription: PushSubscription,
  payload: PushPayload,
  vapidKeys: VapidKeys,
  subject: string,
): Promise<void> {
  const plaintext = JSON.stringify(payload);
  const plaintextBuf = Buffer.from(plaintext, "utf-8");

  if (plaintextBuf.length > MAX_PAYLOAD_SIZE) {
    throw new Error(
      `Payload too large: ${String(plaintextBuf.length)} bytes (max ${String(MAX_PAYLOAD_SIZE)})`,
    );
  }

  const encrypted = encrypt(plaintextBuf, subscription.keys);
  const headers = buildHeaders(
    encrypted,
    subscription.endpoint,
    vapidKeys,
    subject,
  );

  await post(subscription.endpoint, headers, encrypted);
}

// ---------------------------------------------------------------------------
// Encryption (RFC 8291)
// ---------------------------------------------------------------------------

function encrypt(plaintext: Buffer, keys: PushSubscription["keys"]): Buffer {
  // Decode the subscription's p256dh and auth keys
  const recipientPubKey = base64urlDecode(keys.p256dh);
  const authKey = base64urlDecode(keys.auth);

  // Generate an ephemeral ECDH key pair for this message
  const ecdh = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const senderPrivateKey = crypto.createPrivateKey({
    key: ecdh.privateKey.export({ type: "pkcs8", format: "der" }),
    format: "der",
    type: "pkcs8",
  });
  const senderPublicDer = ecdh.publicKey.export({
    type: "spki",
    format: "der",
  });
  const senderPublicKey = senderPublicDer.subarray(senderPublicDer.length - 65);

  // Derive the shared secret via ECDH
  const sharedSecret = crypto.diffieHellman({
    privateKey: senderPrivateKey,
    publicKey: crypto.createPublicKey({
      key: concat(
        Buffer.from(
          "3059301306072a8648ce3d020106082a8648ce3d030107034200",
          "hex",
        ),
        recipientPubKey,
      ),
      format: "der",
      type: "spki",
    }),
  });

  // Derive the pseudo-random key (PRK) using HKDF with auth
  const prk = hkdfExtract(authKey, sharedSecret);

  // Derive the encryption key and nonce
  const keyInfo = concat(
    Buffer.from("Content-Encoding: aes128gcm\0", "utf-8"),
    senderPublicKey,
  );
  const nonceInfo = Buffer.from("Content-Encoding: nonce\0", "utf-8");

  const encryptionKey = hkdfExpand(prk, keyInfo, KEY_LENGTH);
  const nonce = hkdfExpand(prk, nonceInfo, NONCE_LENGTH);

  // Generate a random salt
  const salt = crypto.randomBytes(SALT_LENGTH);

  // Pad the plaintext: plaintext + 2-byte padding delimiter (0x02 0x00 for no padding)
  // RFC 8291 §4: record is plaintext || 0x02 || padding zeros
  const padded = concat(plaintext, Buffer.from([0x02]));

  // Encrypt with AES-128-GCM
  const cipher = crypto.createCipheriv("aes-128-gcm", encryptionKey, nonce);
  const ciphertext = cipher.update(padded);
  const authTag = cipher.getAuthTag();

  // RFC 8291 §4: salt (16) || rs (4, big-endian, 4096) || sender pubkey (65) || ciphertext || tag
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);

  return concat(salt, rs, senderPublicKey, ciphertext, authTag);
}

// ---------------------------------------------------------------------------
// HKDF helpers
// ---------------------------------------------------------------------------

function hkdfExtract(salt: Buffer, ikm: Buffer): Buffer {
  const hmac = crypto.createHmac("sha256", salt);
  hmac.update(ikm);
  return hmac.digest();
}

function hkdfExpand(prk: Buffer, info: Buffer, length: number): Buffer {
  const hmac = crypto.createHmac("sha256", prk);
  hmac.update(concat(info, Buffer.from([0x01])));
  const t = hmac.digest();
  return t.subarray(0, length);
}

// ---------------------------------------------------------------------------
// VAPID JWT signing (RFC 8292)
// ---------------------------------------------------------------------------

function buildVapidJwt(
  audience: string,
  vapidKeys: VapidKeys,
  subject: string,
): string {
  const header = base64url(Buffer.from('{"alg":"ES256","typ":"JWT"}', "utf-8"));

  const exp = Math.floor(Date.now() / 1000) + 12 * 60 * 60; // 12 hours
  const claims = JSON.stringify({ aud: audience, exp, sub: subject });
  const payload = base64url(Buffer.from(claims, "utf-8"));

  const signInput = `${header}.${payload}`;

  // Reconstruct the private key from the raw 32-byte scalar
  // P-256 PKCS8 DER wrapper: 39 bytes header + 32 bytes scalar (with 0x00 prefix)
  const privScalar = base64urlDecode(vapidKeys.privateKey);
  // Build the EC private key in SEC1 DER format
  const sec1Der = concat(
    Buffer.from("30770201010420", "hex"),
    privScalar,
    Buffer.from("a00a06082a8648ce3d030107a14403420004", "hex"),
    base64urlDecode(vapidKeys.publicKey),
  );
  const privateKey = crypto.createPrivateKey({
    key: sec1Der,
    format: "der",
    type: "sec1",
  });

  const signature = crypto.sign("sha256", Buffer.from(signInput), privateKey);
  // ECDSA signature is a DER-encoded SEQUENCE of two INTEGERs.
  // Web Push requires base64url encoding of the raw DER.
  const sigB64 = base64url(signature);

  return `${signInput}.${sigB64}`;
}

// ---------------------------------------------------------------------------
// HTTP headers
// ---------------------------------------------------------------------------

function buildHeaders(
  encrypted: Buffer,
  endpoint: string,
  vapidKeys: VapidKeys,
  subject: string,
): Record<string, string> {
  const audience = new URL(endpoint).origin;
  const jwt = buildVapidJwt(audience, vapidKeys, subject);

  return {
    "Content-Type": "application/octet-stream",
    "Content-Encoding": CONTENT_ENCODING,
    "Content-Length": String(encrypted.length),
    Authorization: `vapid t=${jwt}, k=${vapidKeys.publicKey}`,
    TTL: "86400",
    Urgency: "high",
  };
}

// ---------------------------------------------------------------------------
// HTTP POST
// ---------------------------------------------------------------------------

function post(
  endpoint: string,
  headers: Record<string, string>,
  body: Buffer,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    const isHttps = url.protocol === "https:";
    const mod = isHttps ? https : http;

    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: "POST",
        headers,
      },
      (res) => {
        // Drain the response body
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          if (
            res.statusCode !== undefined &&
            (res.statusCode < 200 || res.statusCode > 299)
          ) {
            const body = Buffer.concat(chunks).toString("utf-8");
            reject(
              new Error(
                `Push service returned ${String(res.statusCode)}: ${body}`,
              ),
            );
          } else {
            resolve();
          }
        });
      },
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function base64urlDecode(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

function base64url(input: Buffer): string {
  return input.toString("base64url");
}

function concat(...buffers: Buffer[]): Buffer {
  return Buffer.concat(buffers);
}

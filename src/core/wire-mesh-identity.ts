/**
 * Adapts agent-comms' own PeerIdentity (a PEM-encoded ECDSA P-256 keypair plus a self-signed X.509 certificate, identity.ts's own concern) into wire-mesh-core's IdentityPort -- the shape MeshSession and createTlsTransport both expect. Both sides wrap the exact same keypair; only the envelope differs. The certificate itself plays no part here -- IdentityPort's own device-id is derived straight from the raw public key, identically to how identity.ts's own deriveDeviceId already works, so the two stay consistent by construction rather than by convention.
 */

import { webcrypto } from "node:crypto";
import { createNodeIdentity } from "wire-mesh-core/adapters/node-identity";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import type { PeerIdentity } from "./identity.js";
import { rawPublicKeyFromPrivateKey } from "./identity.js";

/** COSE algorithm identifier for ES256 (P-256 + SHA-256) -- wire-mesh's own identity-key.alg convention. */
const ES256 = -7;

/** Strips a PEM envelope down to its raw DER bytes, copied into a fresh, non-shared, whole-buffer Uint8Array -- Web Crypto's BufferSource parameters reject a view over a SharedArrayBuffer or a sub-range view, neither of which Buffer.from's return type is guaranteed not to be. */
function pemToDer(pem: string, label: string): Uint8Array<ArrayBuffer> {
  const b64 = pem
    .replace(new RegExp(`-----BEGIN ${label}-----`), "")
    .replace(new RegExp(`-----END ${label}-----`), "")
    .replace(/\s/g, "");
  return Uint8Array.from(Buffer.from(b64, "base64"));
}

export async function toIdentityPort(
  identity: Readonly<PeerIdentity>,
): Promise<IdentityPort> {
  const privateKeyDer = pemToDer(identity.privateKey, "PRIVATE KEY");
  const privateKey = await webcrypto.subtle.importKey(
    "pkcs8",
    privateKeyDer,
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign"],
  );
  const publicKeyBytes = rawPublicKeyFromPrivateKey(identity.privateKey);
  return createNodeIdentity(privateKey, publicKeyBytes, ES256);
}

/**
 * Fetches an armored OpenPGP public key from keys.openpgp.org's Verifying Key Server (VKS) HTTPS API by exact fingerprint (agent-comms#188) -- the convenience path a connection-code redeemer takes when they know the signer's fingerprint but weren't handed the armored key block directly.
 *
 * The keyserver is never a trust anchor here: the fingerprint the caller supplies is already the thing they independently trust (per connection-code.ts's own doc comment), and this function's only job is turning that fingerprint into bytes. It does not, by itself, prove the fetched key actually has that fingerprint -- ConnectionCodeLedger.redeem's own expectedFingerprint check (comparing the openpgp-computed fingerprint of whatever key actually verifies the signature against what the caller asked for) is what defends against a compromised or buggy keyserver returning the wrong key; this function only saves the caller a manual copy-paste when they already know the fingerprint but not the key text.
 */

const KEYSERVER_BASE_URL = "https://keys.openpgp.org/vks/v1/by-fingerprint";

/** The minimal fetch shape this module actually calls -- a single URL argument returning a Response -- rather than the full `typeof fetch` (which also carries a `preconnect` static and an overload taking a Request/init object neither caller nor test needs), so a test's fake implementation isn't forced to shim unrelated fetch surface it never exercises. */
export type FetchLike = (url: string) => Promise<Response>;

/** Strips whitespace/colons and uppercases a fingerprint for the keyserver's own URL path convention -- mirrors connection-code.ts's normalizeFingerprint, kept separate since that one lowercases for comparison rather than uppercasing for a URL. */
function toKeyserverPathSegment(fingerprint: string): string {
  return fingerprint.replace(/[\s:]+/g, "").toUpperCase();
}

/**
 * Fetches the armored public key for `fingerprint` from keys.openpgp.org. Throws if the lookup fails (not found, network error, non-2xx response) -- there is no fallback value, since a caller who asked for this fingerprint by name needs to know definitively whether it was found, not silently proceed with nothing.
 */
export async function fetchPgpPublicKeyByFingerprint(
  fingerprint: string,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const segment = toKeyserverPathSegment(fingerprint);
  const response = await fetchImpl(`${KEYSERVER_BASE_URL}/${segment}`);
  if (!response.ok) {
    throw new Error(
      `Keyserver lookup for fingerprint ${segment} failed: HTTP ${String(response.status)}`,
    );
  }
  return await response.text();
}

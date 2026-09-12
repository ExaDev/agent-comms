/** Generates a random token-id: tokens.cddl defines token-id as an arbitrary-length bstr, and 16 random bytes (128 bits) is the conventional size for an unguessable identifier, matching a UUIDv4's own random payload. */
export function randomTokenId(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytes;
}

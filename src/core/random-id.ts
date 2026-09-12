/** Generates a random identifier: several of core/room's own fields (token-id, message-id) are defined as an arbitrary-length bstr, and 16 random bytes (128 bits) is the conventional size for an unguessable identifier, matching a UUIDv4's own random payload. */
export function randomId(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytes;
}

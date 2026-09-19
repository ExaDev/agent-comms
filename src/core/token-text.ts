/**
 * The text form of a capability token: one line of base64url-encoded JSON, so a token can be handed from one person to another in a message and pasted back into a tool call.
 */

import type { CapabilityToken } from "wire-mesh-core/generated/protocol";
import {
  deserializeToken,
  isSerializedCapabilityToken,
  serializeToken,
} from "./identity-store.js";
import { CommsError } from "./store.js";

/** The token as a single whitespace-free line. */
export function encodeTokenText(token: CapabilityToken): string {
  return Buffer.from(JSON.stringify(serializeToken(token)), "utf-8").toString(
    "base64url",
  );
}

/** The token a piece of text encodes. Throws INVALID_TOKEN when the text is not one, rather than returning something half-formed. */
export function decodeTokenText(text: string): CapabilityToken {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.from(text.trim(), "base64url").toString("utf-8"),
    );
  } catch {
    throw new CommsError(
      "Text is not a valid capability token",
      "INVALID_TOKEN",
    );
  }
  if (!isSerializedCapabilityToken(parsed)) {
    throw new CommsError(
      "Text is not a valid capability token",
      "INVALID_TOKEN",
    );
  }
  return deserializeToken(parsed);
}

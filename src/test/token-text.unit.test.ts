/**
 * Unit tests for the text form of a capability token, used to hand a dm:send grant from one person to another as a plain string.
 */
import { describe, expect, it } from "vitest";
import type { CapabilityToken } from "wire-mesh-core/generated/protocol";
import { decodeTokenText, encodeTokenText } from "../core/token-text.js";

const bytes = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(new TextEncoder().encode(text));

// A structurally valid stand-in: the codec only serialises a token's byte-string fields, it never verifies one.
const TOKEN: CapabilityToken = [
  bytes("protected"),
  { "4": bytes("key-id") },
  bytes("payload"),
  bytes("signature"),
];

/** Long enough to be plausible text, short enough that it cannot be the whole token. */
const TRUNCATED_LENGTH = 10;

describe("token text", () => {
  it("round-trips a token exactly", () => {
    expect(decodeTokenText(encodeTokenText(TOKEN))).toEqual(TOKEN);
  });

  it("round-trips a token with no payload", () => {
    const detached: CapabilityToken = [
      bytes("protected"),
      {},
      null,
      bytes("signature"),
    ];
    expect(decodeTokenText(encodeTokenText(detached))).toEqual(detached);
  });

  it("encodes to a single line with no whitespace, safe to paste into a message", () => {
    expect(encodeTokenText(TOKEN)).toMatch(/^\S+$/);
  });

  it("tolerates whitespace around a pasted token", () => {
    expect(decodeTokenText(`  ${encodeTokenText(TOKEN)}\n`)).toEqual(TOKEN);
  });

  it("rejects text that is not a token, with a message naming what was wrong", () => {
    for (const text of [
      "",
      "not a token",
      "e30",
      encodeTokenText(TOKEN).slice(0, TRUNCATED_LENGTH),
    ]) {
      expect(() => decodeTokenText(text)).toThrow(
        /not a valid capability token/,
      );
    }
  });
});

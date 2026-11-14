/**
 * Key-derivation parameters from an untrusted account bundle are validated completely, every failure being the documented invalid-bundle error.
 */

import { describe, expect, it } from "vitest";
import {
  ACCOUNT_BUNDLE_PREFIX,
  openAccountBundle,
  sealAccountBundle,
} from "../core/account-bundle.js";
import { generateIdentity } from "../core/identity.js";

const PASSPHRASE = "correct horse battery staple";
const CONTENTS = { privateKey: generateIdentity().privateKey };
/** scrypt's cost parameter as this build writes it, as a power of two. */
const COST_LOG2 = 17;
const LOWER_COST_LOG2 = 10;
const FAR_ABOVE_COST_LOG2 = 40;

type Envelope = Record<string, unknown> & {
  tag: string;
  iv: string;
  salt?: string;
};

function decodeBundle(bundle: string): Envelope {
  const text = bundle.slice(ACCOUNT_BUNDLE_PREFIX.length);
  return JSON.parse(
    Buffer.from(text, "base64url").toString("utf-8"),
  ) as Envelope;
}

function encodeBundle(envelope: Readonly<Record<string, unknown>>): string {
  return `${ACCOUNT_BUNDLE_PREFIX}${Buffer.from(JSON.stringify(envelope)).toString("base64url")}`;
}

function withField(bundle: string, changes: Record<string, unknown>): string {
  return encodeBundle({ ...decodeBundle(bundle), ...changes });
}

function expectInvalid(action: () => unknown): void {
  expect(action).toThrow(expect.objectContaining({ code: "INVALID_BUNDLE" }));
}

const bundle = sealAccountBundle(CONTENTS, PASSPHRASE);

describe("the key-derivation parameters of an untrusted bundle", () => {
  it.each([
    ["n of zero", { n: 0 }],
    ["n of one", { n: 1 }],
    ["n that is not a power of two", { n: 3 }],
    ["n just under a power of two", { n: 2 ** COST_LOG2 - 1 }],
    ["n above this build's cost", { n: 2 ** (COST_LOG2 + 1) }],
    ["n far above this build's cost", { n: 2 ** FAR_ABOVE_COST_LOG2 }],
    ["n that is not an integer", { n: 2.5 }],
    ["a negative n", { n: -2 }],
    ["r of zero", { r: 0 }],
    ["r above this build's", { r: 9 }],
    ["p of zero", { p: 0 }],
    ["p above this build's", { p: 2 }],
    ["a salt that is empty", { salt: "" }],
    ["a salt that is too short", { salt: "AAAA" }],
    ["an iv that is empty", { iv: "" }],
    ["a kdf this build does not know", { kdf: "pbkdf2" }],
  ])(
    "%s is refused as an invalid bundle, never thrown raw",
    (_name, changes) => {
      expectInvalid(() =>
        openAccountBundle(withField(bundle, changes), PASSPHRASE),
      );
    },
  );

  it("opens with lower costs that are valid, since they derive a different key and the passphrase still has to open the envelope", () => {
    const lower = withField(bundle, { n: 2 ** LOWER_COST_LOG2 });
    expect(() => openAccountBundle(lower, PASSPHRASE)).toThrow(
      expect.objectContaining({ code: "WRONG_PASSPHRASE" }),
    );
  });

  it("still opens a bundle this build wrote", () => {
    expect(openAccountBundle(bundle, PASSPHRASE)).toEqual(CONTENTS);
  });
});

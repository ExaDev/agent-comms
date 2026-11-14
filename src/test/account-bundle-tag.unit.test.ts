/**
 * Sealed account envelopes read from outside: an authentication tag shorter than GCM's full length, or an iv of another length, is never accepted.
 */

import { describe, expect, it } from "vitest";
import {
  ACCOUNT_BUNDLE_PREFIX,
  openAccountBundle,
  openAccountKeyFromInvite,
  sealAccountBundle,
  sealAccountKeyForInvite,
  type AccountInviteSecret,
} from "../core/account-bundle.js";
import {
  deriveAccountLedgerKeys,
  openLedgerEntry,
  sealLedgerEntry,
  writerLogId,
  generateWriterNonce,
} from "../core/account-ledger-crypto.js";
import { generateIdentity } from "../core/identity.js";
import { randomId } from "../core/random-id.js";

const PASSPHRASE = "correct horse battery staple";
const CONTENTS = { privateKey: generateIdentity().privateKey };
/** The size of GCM's full-length tag, and of the iv this build writes. */
const FULL_TAG_BYTES = 16;
const IV_BYTES = 12;
/** Every tag length shorter than the full one, in bytes. */
const SHORTENED_TAG_BYTES = Array.from(
  { length: FULL_TAG_BYTES - 1 },
  (_, index) => index + 1,
);
const SALT_BYTES = 16;
const SHORT_IV_BYTES = 8;
const ODD_IV_BYTES = [0, SHORT_IV_BYTES, SALT_BYTES];
/** A device-id is 32 bytes. */
const DEVICE_ID_BYTES = 32;
/** Base64 encodes three bytes as four characters. */
const BASE64_CHARS_PER_3_BYTES = 4;
const BYTES_PER_BASE64_GROUP = 3;

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

describe("the authentication tag of an account bundle", () => {
  it("opens when it is full length", () => {
    expect(decodeBundle(bundle).tag).toHaveLength(
      Math.ceil(
        (FULL_TAG_BYTES * BASE64_CHARS_PER_3_BYTES) / BYTES_PER_BASE64_GROUP,
      ),
    );
    expect(openAccountBundle(bundle, PASSPHRASE)).toEqual(CONTENTS);
  });

  it.each(SHORTENED_TAG_BYTES)(
    "is refused as an invalid bundle when it is cut to %i bytes",
    (bytes) => {
      const tag = Buffer.from(decodeBundle(bundle).tag, "base64url");
      const shortened = withField(bundle, {
        tag: tag.subarray(0, bytes).toString("base64url"),
      });
      expectInvalid(() => openAccountBundle(shortened, PASSPHRASE));
    },
  );

  it("is refused as an invalid bundle when it is longer than GCM's", () => {
    const tag = Buffer.from(decodeBundle(bundle).tag, "base64url");
    const longer = withField(bundle, {
      tag: Buffer.concat([tag, Buffer.from([0])]).toString("base64url"),
    });
    expectInvalid(() => openAccountBundle(longer, PASSPHRASE));
  });
});

describe("the authentication tag of an invite envelope", () => {
  const invite: AccountInviteSecret = {
    code: "invite-code",
    expiresAt: "2099-01-01T00:00:00.000Z",
    deviceId: "ab".repeat(DEVICE_ID_BYTES),
  };
  const sealed = sealAccountKeyForInvite(CONTENTS, invite);
  const envelope = JSON.parse(
    Buffer.from(sealed, "base64url").toString("utf-8"),
  ) as Envelope;

  it("opens when it is full length", () => {
    expect(openAccountKeyFromInvite(sealed, invite)).toEqual(CONTENTS);
  });

  it.each(SHORTENED_TAG_BYTES)(
    "is refused as an invalid bundle when it is cut to %i bytes",
    (bytes) => {
      const tag = Buffer.from(envelope.tag, "base64url").subarray(0, bytes);
      const shortened = Buffer.from(
        JSON.stringify({ ...envelope, tag: tag.toString("base64url") }),
      ).toString("base64url");
      expectInvalid(() => openAccountKeyFromInvite(shortened, invite));
    },
  );

  it.each(ODD_IV_BYTES)(
    "is refused as an invalid bundle with an iv of %i bytes",
    (bytes) => {
      const odd = Buffer.from(
        JSON.stringify({
          ...envelope,
          iv: Buffer.alloc(bytes, 1).toString("base64url"),
        }),
      ).toString("base64url");
      expectInvalid(() => openAccountKeyFromInvite(odd, invite));
    },
  );
});

describe("a ledger entry", () => {
  const keys = deriveAccountLedgerKeys(generateIdentity().privateKey);
  const log = writerLogId(keys, generateWriterNonce());
  const plaintext = randomId();

  it("does not open once any of its tag bytes is dropped", () => {
    const sealed = sealLedgerEntry(keys, log, 1, plaintext);
    const ivEnd = 1 + IV_BYTES;
    for (let dropped = 1; dropped <= FULL_TAG_BYTES; dropped++) {
      const shortened = Uint8Array.from([
        ...sealed.subarray(0, ivEnd + FULL_TAG_BYTES - dropped),
        ...sealed.subarray(ivEnd + FULL_TAG_BYTES),
      ]);
      expect(openLedgerEntry(keys, log, 1, shortened)).toBeUndefined();
    }
  });
});

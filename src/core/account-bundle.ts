/**
 * The account key in transit (agent-comms#344): the one deliberate way a user principal's private key leaves the machine it lives on, so a second machine can hold the same account and, through the replicated grant ledger, see and revoke everything the first minted. The key only ever travels sealed: under a passphrase for an export the person carries themselves, or under a key derived from a one-time account invite for a join, never as plaintext.
 */

import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { z } from "zod";
import { parseDisplayName } from "./display-name.js";
import { CommsError } from "./store.js";

/** The text an exported bundle starts with, so a file can be recognised for what it is before any decryption is attempted. */
export const ACCOUNT_BUNDLE_PREFIX = "agent-comms-account:v1:";

/** scrypt's cost as OWASP's password storage guidance recommends it (N = 2^17, r = 8, p = 1): slow enough that guessing a passphrase against a stolen bundle is expensive, fast enough for a once-per-machine export or import. */
const SCRYPT_COST_LOG2 = 17;
const SCRYPT_COST = 2 ** SCRYPT_COST_LOG2;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELISM = 1;
/** scrypt needs 128 * N * r bytes of memory; Node refuses by default above 32 MiB, so the limit is raised to exactly twice what these parameters need. */
const SCRYPT_BYTES_PER_UNIT = 128;
const SCRYPT_MAX_MEMORY =
  2 * SCRYPT_BYTES_PER_UNIT * SCRYPT_COST * SCRYPT_BLOCK_SIZE;
/** A 128-bit salt, the size NIST SP 800-132 sets as the minimum. */
const SALT_BYTES = 16;
const KEY_BYTES = 32;
/** GCM's specified IV length. */
const IV_BYTES = 12;
/** The shortest passphrase an export accepts. Twelve characters is the length NCSC and NIST guidance treat as the floor for a passphrase protecting something offline-attackable; the scrypt cost above does the rest. */
export const MIN_ACCOUNT_PASSPHRASE_LENGTH = 12;

const INVITE_KEY_INFO = "agent-comms/account-invite/v1";
const BUNDLE_AAD = Buffer.from(ACCOUNT_BUNDLE_PREFIX);

const base64url = z.string().regex(/^[A-Za-z0-9_-]*$/);

/** What an account export or a join carries: the PEM private key and the name the account asserts for itself, if it has one. */
export interface AccountContents {
  privateKey: string;
  displayName?: string;
}

const accountContentsSchema = z
  .object({ privateKey: z.string(), displayName: z.string().optional() })
  .strict();

/** The contents as the plaintext a bundle or a join seals. */
function contentsText(contents: Readonly<AccountContents>): string {
  return JSON.stringify(contents);
}

/** The contents a sealed plaintext holds. Throws INVALID_BUNDLE for a plaintext that is not account contents or whose name breaks the display-name rules, since a name from outside is shown to people. */
function parseContents(plaintext: string, damaged: string): AccountContents {
  let decoded: unknown;
  try {
    decoded = JSON.parse(plaintext);
  } catch {
    throw new CommsError(damaged, "INVALID_BUNDLE");
  }
  const contents = accountContentsSchema.safeParse(decoded);
  if (
    !contents.success ||
    (contents.data.displayName !== undefined &&
      parseDisplayName(contents.data.displayName) !== contents.data.displayName)
  ) {
    throw new CommsError(damaged, "INVALID_BUNDLE");
  }
  return {
    privateKey: contents.data.privateKey,
    ...(contents.data.displayName === undefined
      ? {}
      : { displayName: contents.data.displayName }),
  };
}

const passphraseEnvelopeSchema = z
  .object({
    kdf: z.literal("scrypt"),
    n: z.number().int().positive(),
    r: z.number().int().positive(),
    p: z.number().int().positive(),
    salt: base64url,
    iv: base64url,
    tag: base64url,
    ct: base64url,
  })
  .strict();

const inviteEnvelopeSchema = z
  .object({ iv: base64url, tag: base64url, ct: base64url })
  .strict();

function seal(
  key: Buffer,
  plaintext: string,
): { iv: string; tag: string; ct: string } {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(BUNDLE_AAD);
  const ct = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  return {
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ct: ct.toString("base64url"),
  };
}

/** The plaintext of a sealed envelope, or undefined if the key is wrong or the envelope was altered. */
function open(
  key: Buffer,
  envelope: Readonly<{ iv: string; tag: string; ct: string }>,
): string | undefined {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.iv, "base64url"),
  );
  decipher.setAAD(BUNDLE_AAD);
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ct, "base64url")),
      decipher.final(),
    ]).toString("utf-8");
  } catch {
    return undefined;
  }
}

function passphraseKey(
  passphrase: string,
  salt: Buffer,
  cost: Readonly<{ n: number; r: number; p: number }>,
): Buffer {
  return scryptSync(passphrase, salt, KEY_BYTES, {
    N: cost.n,
    r: cost.r,
    p: cost.p,
    maxmem: SCRYPT_MAX_MEMORY,
  });
}

/** Seals the account's contents under a passphrase, as one line of text. Throws WEAK_PASSPHRASE for a passphrase shorter than MIN_ACCOUNT_PASSPHRASE_LENGTH. */
export function sealAccountBundle(
  contents: Readonly<AccountContents>,
  passphrase: string,
): string {
  if (passphrase.length < MIN_ACCOUNT_PASSPHRASE_LENGTH) {
    throw new CommsError(
      `An account export passphrase must be at least ${String(MIN_ACCOUNT_PASSPHRASE_LENGTH)} characters`,
      "WEAK_PASSPHRASE",
    );
  }
  const salt = randomBytes(SALT_BYTES);
  const cost = { n: SCRYPT_COST, r: SCRYPT_BLOCK_SIZE, p: SCRYPT_PARALLELISM };
  const envelope = {
    kdf: "scrypt",
    ...cost,
    salt: salt.toString("base64url"),
    ...seal(passphraseKey(passphrase, salt, cost), contentsText(contents)),
  };
  return `${ACCOUNT_BUNDLE_PREFIX}${Buffer.from(JSON.stringify(envelope)).toString("base64url")}`;
}

/** The account contents a bundle holds. Throws INVALID_BUNDLE for text that is not a bundle this build can read, and WRONG_PASSPHRASE when the passphrase does not open it. The cost parameters are read from the bundle but capped at this build's own, so a crafted bundle cannot make an import run for hours. */
export function openAccountBundle(
  bundle: string,
  passphrase: string,
): AccountContents {
  const text = bundle.trim();
  if (!text.startsWith(ACCOUNT_BUNDLE_PREFIX)) {
    throw new CommsError("Not an agent-comms account bundle", "INVALID_BUNDLE");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      Buffer.from(
        text.slice(ACCOUNT_BUNDLE_PREFIX.length),
        "base64url",
      ).toString("utf-8"),
    );
  } catch {
    throw new CommsError("The account bundle is damaged", "INVALID_BUNDLE");
  }
  const envelope = passphraseEnvelopeSchema.safeParse(decoded);
  if (
    !envelope.success ||
    envelope.data.n > SCRYPT_COST ||
    envelope.data.r > SCRYPT_BLOCK_SIZE ||
    envelope.data.p > SCRYPT_PARALLELISM
  ) {
    throw new CommsError("The account bundle is damaged", "INVALID_BUNDLE");
  }
  const key = passphraseKey(
    passphrase,
    Buffer.from(envelope.data.salt, "base64url"),
    envelope.data,
  );
  const plaintext = open(key, envelope.data);
  if (plaintext === undefined) {
    throw new CommsError(
      "The passphrase does not open this account bundle",
      "WRONG_PASSPHRASE",
    );
  }
  return parseContents(plaintext, "The account bundle is damaged");
}

/** The fields of an account invite both ends know: the invite's own single-use nonce is the secret, and the expiry and issuing device are bound in so a sealed key cannot be replayed under a different invite. */
export interface AccountInviteSecret {
  code: string;
  expiresAt: string;
  deviceId: string;
}

function inviteKey(invite: Readonly<AccountInviteSecret>): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(invite.code),
      Buffer.from(`${invite.expiresAt}:${invite.deviceId}`),
      INVITE_KEY_INFO,
      KEY_BYTES,
    ),
  );
}

/** Seals the account's contents for the machine redeeming `invite`. The invite's nonce carries enough entropy to key it directly, with no passphrase stretching needed. */
export function sealAccountKeyForInvite(
  contents: Readonly<AccountContents>,
  invite: Readonly<AccountInviteSecret>,
): string {
  return Buffer.from(
    JSON.stringify(seal(inviteKey(invite), contentsText(contents))),
  ).toString("base64url");
}

/** The account contents sealed for `invite`. Throws INVALID_BUNDLE when the text does not open under that invite. */
export function openAccountKeyFromInvite(
  sealed: string,
  invite: Readonly<AccountInviteSecret>,
): AccountContents {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(sealed, "base64url").toString("utf-8"));
  } catch {
    throw new CommsError("The sealed account key is damaged", "INVALID_BUNDLE");
  }
  const envelope = inviteEnvelopeSchema.safeParse(decoded);
  const plaintext = envelope.success
    ? open(inviteKey(invite), envelope.data)
    : undefined;
  if (plaintext === undefined) {
    throw new CommsError(
      "The sealed account key does not open under this invite",
      "INVALID_BUNDLE",
    );
  }
  return parseContents(plaintext, "The sealed account key is damaged");
}

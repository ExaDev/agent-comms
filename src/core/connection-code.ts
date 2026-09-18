/**
 * ConnectionCode generation and redemption (agent-comms#188): bootstraps GatewayTrust between two devices that have never established a mesh connection, since GatewayTrust's own deny-by-default, pin-the-key model otherwise requires a device-id to already be known and pasted in by hand (gateway_trust). One artifact, one generation flow, one redemption flow -- never two mechanisms bolted together.
 *
 * `code`/`expiresAt` are the always-checked half: freshness/liveness proof that whoever redeems this was on the other end of this exact exchange, recently. `signature` is the optional half: a detached PGP signature (armored) over `${code}:${expiresAt}:${deviceId}`, checked only when present. Redemption never requires a signature -- a device with no PGP identity still generates and redeems a bare code -- but when one is present, verifying it needs the signer's own public key, supplied by the caller either as a pasted armored block or (see pgp-keyserver.ts) fetched from a keyserver by fingerprint. Either way, a caller who also supplies the fingerprint they already independently trust gets it pinned: the verified key's own computed fingerprint must equal it, or redemption fails.
 *
 * PGP key material is never generated, stored, or managed by this module or by agent-comms generally -- signing and verification both take key material supplied per call by the caller, exactly as invoking `gpg --sign`/`gpg --verify` directly would. Building a persisted PGP-identity subsystem (key generation, passphrase storage, revocation) is a materially larger, security-sensitive scope the settled design (agent-comms#188) never asked for; a caller who wants a code signed brings whatever real-world PGP identity they already have (git-commit signing key, personal key on a keyserver, etc.) rather than trusting agent-comms to mint and hold a new one on their behalf.
 *
 * Persistence (ConnectionCodeLedger, backed by identity-store.ts's connection-code ledger) is two independent halves, not a request/response pair: the generating device's own issued-code record survives a restart between generation and hand-off (identity-store.ts's own doc comment on why), while the redeeming device's own redeemed-nonce record survives a restart within the code's own short validity window, enforcing genuine single-use locally rather than merely advisory "please don't reuse this" convention. Redemption never consults the issuer's own ledger -- there is no network round-trip back to whoever generated the code, since the whole point of this bootstrap is working before any connection between the two devices exists.
 */

import * as openpgp from "openpgp";
import { nanoid } from "./nanoid.js";
import {
  loadConnectionCodeLedger,
  saveConnectionCodeLedger,
} from "./identity-store.js";
import type { IdentitySlot, StoredConnectionCode } from "./identity-store.js";
import type { ConnectionCode } from "./types.js";

/** Nonce length: longer than nanoid's own 21-character default, since this identifier doubles as the single-use token a redemption check keys off, not merely a display id. */
const CONNECTION_CODE_NONCE_LENGTH = 32;

/** Minutes a generated code stays valid absent an explicit ttlMs override. */
const DEFAULT_CONNECTION_CODE_TTL_MINUTES = 15;
/** Seconds per minute, used to convert DEFAULT_CONNECTION_CODE_TTL_MINUTES to milliseconds. */
const SECONDS_PER_MINUTE = 60;
/** Milliseconds per second, used to convert DEFAULT_CONNECTION_CODE_TTL_MINUTES to milliseconds. */
const MS_PER_SECOND = 1000;

/** Default validity window for a generated code absent an explicit ttlMs: long enough for a human to relay it out of band (Slack, a phone call), short enough that "freshness" actually means something. */
export const DEFAULT_CONNECTION_CODE_TTL_MS =
  DEFAULT_CONNECTION_CODE_TTL_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND;

/** Every reason ConnectionCodeLedger.redeem can reject a candidate code. */
export type ConnectionCodeInvalidReason =
  | "expired"
  | "already_redeemed"
  | "signature_required"
  | "signature_invalid"
  | "fingerprint_mismatch";

/** Thrown by ConnectionCodeLedger.redeem for every rejection reason above -- callers branch on `reason` rather than parsing `message`. */
export class ConnectionCodeError extends Error {
  constructor(
    public readonly reason: ConnectionCodeInvalidReason,
    message: string,
  ) {
    super(message);
    this.name = "ConnectionCodeError";
  }
}

/** The exact canonical message a connection code's signature is computed over -- shared by generation and redemption so both sides agree on what was actually signed. Field order and the `:` separator are fixed by this function alone; `code` and `deviceId` are both hex/base64url alphabets that never contain `:`, so the three fields can't be confused with each other under concatenation. */
function connectionCodeMessage(
  candidate: Readonly<{
    code: string;
    expiresAt: string;
    deviceId: string;
  }>,
): string {
  return `${candidate.code}:${candidate.expiresAt}:${candidate.deviceId}`;
}

/** Signs `message` with `privateKeyArmored`, decrypting it with `passphrase` first if it is passphrase-protected. Returns the detached, armored PGP signature. */
async function signConnectionCodeMessage(
  message: string,
  privateKeyArmored: string,
  passphrase?: string,
): Promise<string> {
  let privateKey = await openpgp.readPrivateKey({
    armoredKey: privateKeyArmored,
  });
  if (!privateKey.isDecrypted()) {
    privateKey = await openpgp.decryptKey(
      passphrase === undefined ? { privateKey } : { privateKey, passphrase },
    );
  }
  const unsignedMessage = await openpgp.createMessage({ text: message });
  // openpgp.d.ts's own sign() overloads return a conditional type keyed off T extends WebStream<Data>/NodeWebStream<Data>, which ESLint's own type-aware checking (typescript-eslint's projectService) can't resolve concretely here even though tsc itself has no trouble with it -- widening to `unknown` and narrowing with a runtime typeof check is the honest fix (Type Safety: "unknown with type narrowing"), not a cast papering over a real mismatch tsc would otherwise catch.
  const signResult: unknown = await openpgp.sign({
    message: unsignedMessage,
    signingKeys: privateKey,
    detached: true,
  });
  if (typeof signResult !== "string") {
    throw new TypeError(
      "openpgp.sign returned a stream rather than an armored string -- unexpected for a non-streaming Message input",
    );
  }
  return signResult;
}

/** The result of checking a connection code's signature against a supplied public key: whether it verified, and (when readable) the signing key's own fingerprint, so a caller can compare it against whatever fingerprint they already trust. */
interface VerifyConnectionCodeSignatureResult {
  valid: boolean;
  fingerprint?: string;
}

/** Verifies `signatureArmored` (a detached PGP signature) over `message` against `publicKeyArmored`. Never throws for an ordinary verification failure (wrong key, tampered message) -- returns `{ valid: false }` instead, reserving thrown errors for malformed input (unparsable armored text). */
async function verifyConnectionCodeSignature(
  message: string,
  signatureArmored: string,
  publicKeyArmored: string,
): Promise<VerifyConnectionCodeSignatureResult> {
  const publicKey = await openpgp.readKey({ armoredKey: publicKeyArmored });
  const fingerprint = publicKey.getFingerprint();
  const pgpMessage = await openpgp.createMessage({ text: message });
  const signature = await openpgp.readSignature({
    armoredSignature: signatureArmored,
  });
  const verificationResult = await openpgp.verify({
    message: pgpMessage,
    signature,
    verificationKeys: publicKey,
  });
  const [sigResult] = verificationResult.signatures;
  if (sigResult === undefined) return { valid: false, fingerprint };
  try {
    await sigResult.verified;
    return { valid: true, fingerprint };
  } catch {
    return { valid: false, fingerprint };
  }
}

/** Normalises a PGP fingerprint for comparison: openpgp.js's own getFingerprint() returns lowercase hex with no separators, but a human pasting one in from a keyserver page or business card may add spaces, colons, or uppercase. */
function normalizeFingerprint(fingerprint: string): string {
  return fingerprint.replace(/[\s:]+/g, "").toLowerCase();
}

export interface GenerateConnectionCodeOptions {
  /** Overrides DEFAULT_CONNECTION_CODE_TTL_MS. */
  ttlMs?: number;
  /** Armored PGP private key to sign the code with. Omitted entirely -- not merely absent a signature -- when the caller has no PGP identity to sign with; the generated code is then bare, exactly as valid to redeem, just without the optional persistent-identity proof. */
  privateKeyArmored?: string;
  /** Passphrase for privateKeyArmored, if it is passphrase-protected. Ignored if privateKeyArmored is omitted. */
  passphrase?: string;
  /** Injectable clock for tests; defaults to Date.now(). */
  now?: number;
}

export interface RedeemConnectionCodeOptions {
  /** The signer's own armored PGP public key, needed only when the candidate code carries a signature. */
  publicKeyArmored?: string;
  /** A PGP fingerprint the caller already has independent reason to trust. When supplied alongside a signed code, the verified signing key's own computed fingerprint must equal it (case- and whitespace-insensitive) or redemption fails with "fingerprint_mismatch". When omitted, a present signature is still verified against publicKeyArmored, but nothing pins it to a fingerprint the caller actually recognises. */
  expectedFingerprint?: string;
  /** Injectable clock for tests; defaults to Date.now(). */
  now?: number;
}

export interface RedeemConnectionCodeResult {
  /** The device-id the redeemed code vouched for -- the caller's own responsibility to pass on to GatewayTrust.add. */
  deviceId: string;
  /** The signing key's fingerprint, present only when the code carried a signature that verified. */
  fingerprint?: string;
}

/**
 * Generates and redeems ConnectionCode artifacts, enforcing the always-checked freshness/liveness half (expiry, single-use) and the optional PGP-signature half (checked only when a code carries one). Optionally persisted per bridge slot via identity-store.ts's connection-code ledger (see this file's own header comment for what survives a restart and why); constructed with no slot, stays in-memory only, mirroring GatewayTrust's own no-slot fallback.
 */
export class ConnectionCodeLedger {
  private readonly issued = new Map<string, StoredConnectionCode>();
  private readonly redeemed = new Map<string, string>();
  private readonly slot: Readonly<IdentitySlot> | undefined;

  constructor(slot?: Readonly<IdentitySlot>) {
    this.slot = slot;
    if (slot !== undefined) {
      const ledger = loadConnectionCodeLedger(slot);
      for (const [nonce, record] of Object.entries(ledger.issued)) {
        this.issued.set(nonce, record);
      }
      for (const [nonce, expiresAt] of Object.entries(ledger.redeemed)) {
        this.redeemed.set(nonce, expiresAt);
      }
    }
  }

  /** Drops every issued or redeemed entry whose own expiresAt has already passed, so neither map accumulates forever across a long-running process or a slot that survives many restarts. */
  private prune(now: number): void {
    for (const [nonce, record] of this.issued) {
      if (Date.parse(record.expiresAt) <= now) this.issued.delete(nonce);
    }
    for (const [nonce, expiresAt] of this.redeemed) {
      if (Date.parse(expiresAt) <= now) this.redeemed.delete(nonce);
    }
  }

  private persist(): void {
    if (this.slot !== undefined) {
      saveConnectionCodeLedger(this.slot, {
        issued: Object.fromEntries(this.issued),
        redeemed: Object.fromEntries(this.redeemed),
      });
    }
  }

  /**
   * Generates a fresh ConnectionCode vouching for deviceId, optionally signed. The nonce is single-use in the sense that redeem() below will refuse to redeem it twice; nothing prevents the caller from generating any number of independent codes for the same deviceId.
   */
  async generate(
    deviceId: string,
    options: Readonly<GenerateConnectionCodeOptions> = {},
  ): Promise<ConnectionCode> {
    const now = options.now ?? Date.now();
    this.prune(now);
    const code = nanoid(CONNECTION_CODE_NONCE_LENGTH);
    const expiresAt = new Date(
      now + (options.ttlMs ?? DEFAULT_CONNECTION_CODE_TTL_MS),
    ).toISOString();
    const signature =
      options.privateKeyArmored === undefined
        ? undefined
        : await signConnectionCodeMessage(
            connectionCodeMessage({ code, expiresAt, deviceId }),
            options.privateKeyArmored,
            options.passphrase,
          );

    const connectionCode: ConnectionCode =
      signature === undefined
        ? { code, expiresAt, deviceId }
        : { code, expiresAt, deviceId, signature };
    const stored: StoredConnectionCode =
      signature === undefined
        ? { expiresAt, deviceId }
        : { expiresAt, deviceId, signature };
    this.issued.set(code, stored);
    this.persist();
    return connectionCode;
  }

  /**
   * Validates a candidate ConnectionCode and returns the device-id it vouches for. Always checks expiry and single-use; when the candidate carries a signature, also verifies it (requiring options.publicKeyArmored) and, when options.expectedFingerprint is given, pins the verified signing key to it. Throws ConnectionCodeError for every rejection; the caller is responsible for calling GatewayTrust.add(result.deviceId) on success -- this ledger has no dependency on GatewayTrust itself.
   */
  async redeem(
    candidate: Readonly<ConnectionCode>,
    options: Readonly<RedeemConnectionCodeOptions> = {},
  ): Promise<RedeemConnectionCodeResult> {
    const now = options.now ?? Date.now();
    this.prune(now);

    if (Date.parse(candidate.expiresAt) <= now) {
      throw new ConnectionCodeError(
        "expired",
        `Connection code expired at ${candidate.expiresAt}`,
      );
    }
    if (this.redeemed.has(candidate.code)) {
      throw new ConnectionCodeError(
        "already_redeemed",
        "Connection code has already been redeemed",
      );
    }

    let fingerprint: string | undefined;
    if (candidate.signature !== undefined) {
      if (options.publicKeyArmored === undefined) {
        throw new ConnectionCodeError(
          "signature_required",
          "Connection code carries a signature but no public key was supplied to verify it against",
        );
      }
      const message = connectionCodeMessage(candidate);
      const verification = await verifyConnectionCodeSignature(
        message,
        candidate.signature,
        options.publicKeyArmored,
      );
      if (!verification.valid) {
        throw new ConnectionCodeError(
          "signature_invalid",
          "Connection code signature does not verify against the supplied public key",
        );
      }
      fingerprint = verification.fingerprint;
      if (
        options.expectedFingerprint !== undefined &&
        (fingerprint === undefined ||
          normalizeFingerprint(fingerprint) !==
            normalizeFingerprint(options.expectedFingerprint))
      ) {
        throw new ConnectionCodeError(
          "fingerprint_mismatch",
          `Signing key fingerprint ${fingerprint ?? "(unknown)"} does not match the expected fingerprint ${options.expectedFingerprint}`,
        );
      }
    }

    this.redeemed.set(candidate.code, candidate.expiresAt);
    this.persist();
    return fingerprint === undefined
      ? { deviceId: candidate.deviceId }
      : { deviceId: candidate.deviceId, fingerprint };
  }
}

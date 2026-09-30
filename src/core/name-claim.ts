/**
 * A self display name claim (agent-comms#345): the name a key asserts for itself, signed by that key, carried as one line of text beside the proofs in an agent/self advert. The issuer is authentic (the claim carries the public key it verifies under, and that key must hash to the subject's device-id, the same self-certifying check a capability token's issuer-key gets), but the content is whatever the issuer chose, so a receiver shows it as that subject's own claim, never as a fact about it. A machine names itself this way; an agent's name already rides in its own signed advert.
 *
 * The claim expires, like the proofs it rides beside, so a renamed machine's old name ages out of every peer's view without anything having to revoke it.
 */

import type { Clock } from "wire-mesh-core/ports/clock";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { parseDisplayName } from "./display-name.js";

/** Separates a name claim's signature from every other signature the same key makes, so no other signed payload can be replayed as one. */
const NAME_CLAIM_CONTEXT = "agent-comms/name-claim/v1";

/** The longest claim text a receiver will look at: a claim is a short name, a public key and a signature, well under a quarter of this, so anything longer is something else. */
export const MAX_NAME_CLAIM_LENGTH = 2048;

interface NameClaimWire {
  subject: string;
  name: string;
  expires: number;
  alg: number;
  publicKey: string;
  signature: string;
}

function isNameClaimWire(value: unknown): value is NameClaimWire {
  if (typeof value !== "object" || value === null) return false;
  return (
    "subject" in value &&
    typeof value.subject === "string" &&
    "name" in value &&
    typeof value.name === "string" &&
    "expires" in value &&
    typeof value.expires === "number" &&
    "alg" in value &&
    typeof value.alg === "number" &&
    "publicKey" in value &&
    typeof value.publicKey === "string" &&
    "signature" in value &&
    typeof value.signature === "string"
  );
}

/** The exact bytes a claim's signature covers: the context, then every signed field, in a fixed order. */
function signedBytes(
  claim: Readonly<Pick<NameClaimWire, "subject" | "name" | "expires">>,
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify([
      NAME_CLAIM_CONTEXT,
      claim.subject,
      claim.name,
      claim.expires,
    ]),
  );
}

export interface MintNameClaimOptions {
  /** The key naming itself: the claim's subject is its device-id. */
  issuer: IdentityPort;
  clock: Clock;
  /** Must already satisfy parseDisplayName. */
  name: string;
  lifetimeMs: number;
}

/** A fresh claim, as one line of text, that options.issuer calls itself options.name. */
export async function mintNameClaim(
  options: Readonly<MintNameClaimOptions>,
): Promise<string> {
  const unsigned = {
    subject: deviceIdToHex(options.issuer.deviceId),
    name: options.name,
    expires: options.clock.now() + options.lifetimeMs,
  };
  const signature = await options.issuer.sign(signedBytes(unsigned));
  const wire: NameClaimWire = {
    ...unsigned,
    alg: options.issuer.identityKey.alg,
    publicKey: Buffer.from(options.issuer.identityKey["public-key"]).toString(
      "base64url",
    ),
    signature: Buffer.from(signature).toString("base64url"),
  };
  return Buffer.from(JSON.stringify(wire), "utf-8").toString("base64url");
}

export interface VerifyNameClaimOptions {
  claim: string;
  /** The device-id (hex) the claim must be about: the machine a proof has already identified. */
  subject: string;
  /** The verifying node's own identity (for signature checks) and clock. */
  identity: IdentityPort;
  clock: Clock;
}

export type NameClaimVerdict =
  { ok: true; name: string; expires: number } | { ok: false; reason: string };

/** Whether options.claim is a current name claim signed by options.subject's own key, and the name it asserts. Never throws for a bad claim: text that is not a claim, one about another subject, one whose key is not the subject's, a bad signature, an expired claim or an unusable name all come back as a refusal. */
export async function verifyNameClaim(
  options: Readonly<VerifyNameClaimOptions>,
): Promise<NameClaimVerdict> {
  if (options.claim.length > MAX_NAME_CLAIM_LENGTH) {
    return { ok: false, reason: "too_long" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.from(options.claim, "base64url").toString("utf-8"),
    );
  } catch {
    return { ok: false, reason: "not_a_claim" };
  }
  if (!isNameClaimWire(parsed)) return { ok: false, reason: "not_a_claim" };
  if (parsed.subject !== options.subject.toLowerCase()) {
    return { ok: false, reason: "wrong_subject" };
  }
  if (parsed.expires <= options.clock.now()) {
    return { ok: false, reason: "expired" };
  }
  const name = parseDisplayName(parsed.name);
  if (name === undefined || name !== parsed.name) {
    return { ok: false, reason: "unusable_name" };
  }
  const publicKey = Uint8Array.from(Buffer.from(parsed.publicKey, "base64url"));
  const keyOwner = deviceIdToHex(
    await options.identity.deriveDeviceId(publicKey),
  );
  if (keyOwner !== parsed.subject) return { ok: false, reason: "wrong_key" };
  let signed: boolean;
  try {
    signed = await options.identity.verify(
      { alg: parsed.alg, "public-key": publicKey },
      signedBytes(parsed),
      Uint8Array.from(Buffer.from(parsed.signature, "base64url")),
    );
  } catch {
    // An algorithm the verifier does not support, or key bytes it cannot import: either way the claim cannot be checked, which is a refusal.
    return { ok: false, reason: "unusable_key" };
  }
  if (!signed) return { ok: false, reason: "bad_signature" };
  return { ok: true, name, expires: parsed.expires };
}

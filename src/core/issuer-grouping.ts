/**
 * Which grouping issuer each known device belongs to, for one kind of issuer: the machine (agent-comms#343, list_agents' machine-grouped output) or the user principal (agent-comms#266). This device's own issuer is known directly; every other device's is read from the proof of that kind in its gossiped agent/self advert and identified cryptographically (membership-proof.ts's identifyMembershipProofIssuer), so a device is placed under an issuer only when that issuer's key signed a current proof for it. A device with no such proof (a hidden agent, which sends no agent/self advert, or a bridge that predates the proof) has no issuer here.
 *
 * The same pass reads each issuer's self display name claim (agent-comms#345, agent-comms#359) from the adverts of the devices it vouches for, and keeps a name only when the claim is signed by that very issuer's key: the issuer is authentic, the content is its own choice.
 *
 * Grouping is display, not trust: a proof names who vouches for a device id, not that the device gossiping it is that device, so nothing here is used to authorise anything. Identifying a proof is cryptography, so verdicts are remembered per proof text until the proof lapses, and the cache is bounded. For the same reason a failure to identify one proof is reported and leaves that device unplaced rather than failing the listing it feeds.
 */

import {
  readMembershipProof,
  type MembershipProofField,
} from "./gossip-directory.js";
import type { IdentifiedMembershipProof } from "./membership-proof.js";
import type { NameClaimVerdict } from "./name-claim.js";

/** The most proofs, and separately the most name claims, whose verdict is remembered. */
const VERDICT_CACHE_LIMIT = 1024;

export interface IssuerGroupingDeps {
  /** Which agent/self field carries the proofs of the issuer kind this grouping places devices under. */
  field: MembershipProofField;
  /** The name claim a peer gossiped for this kind of issuer, read from its advert. */
  readNameClaim: (
    advert: Readonly<Record<string, unknown>>,
  ) => string | undefined;
  /** Every device this side has heard gossip from, with its latest advert. */
  listKnownDevices: () => readonly {
    deviceId: string;
    advert: Readonly<Record<string, unknown>>;
  }[];
  /** Identifies which issuer a proof shows vouching for a device (MembershipProofs.identify). Called only once getMachineId answers, so the store's identity is attached. */
  identify: (
    claim: Readonly<{ proof: string; deviceHex: string }>,
  ) => Promise<IdentifiedMembershipProof>;
  /** This device's own id (hex). */
  getPeerId: () => string;
  /** This device's own issuer's id (hex), undefined before the store's identity is attached. */
  getOwnIssuerId: () => string | undefined;
  /** Where a proof that could not be identified at all (identify rejected) is reported. */
  onError: (error: Error) => void;
  /** Verifies a gossiped name claim about subject (name-claim.ts's verifyNameClaim, as this node sees it). */
  verifyName: (
    claim: Readonly<{ claim: string; subject: string }>,
  ) => Promise<NameClaimVerdict>;
  /** This device's own issuer's name, read locally. */
  getOwnName: () => string | undefined;
}

interface CachedName {
  subject: string;
  name: string | undefined;
  until: number;
}

interface CachedVerdict {
  deviceHex: string;
  /** The issuer the proof names, undefined for a proof that did not verify. */
  issuer: string | undefined;
  /** When the verdict stops holding (epoch ms): the proof's own expiry, or never for a refusal, since the same text can never become valid later. */
  until: number;
}

export class IssuerGrouping {
  private readonly verdicts = new Map<string, CachedVerdict>();
  private readonly names = new Map<string, CachedName>();

  constructor(private readonly deps: Readonly<IssuerGroupingDeps>) {}

  /** The issuer (hex) of each device this side can place under one, keyed by device id: this device's own, and every gossiped device with a current, valid proof of this kind. */
  async issuersByDevice(): Promise<Map<string, string>> {
    const issuers = new Map<string, string>();
    const own = this.deps.getOwnIssuerId();
    // Without an identity attached there is no clock or revocation view to identify a proof against, and no own issuer either.
    if (own === undefined) return issuers;
    issuers.set(this.deps.getPeerId(), own);
    for (const { deviceId, advert } of this.deps.listKnownDevices()) {
      if (issuers.has(deviceId)) continue;
      const proof = readMembershipProof(advert, this.deps.field);
      if (proof === undefined) continue;
      const issuer = await this.issuerFor(proof, deviceId);
      if (issuer !== undefined) issuers.set(deviceId, issuer);
    }
    return issuers;
  }

  /** The self display name of each issuer this side can place a device under, keyed by issuer id: this device's own from its file, every other one from a claim its own key signed, gossiped by a device it vouches for. */
  async issuerNames(): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const issuers = await this.issuersByDevice();
    const own = this.deps.getOwnIssuerId();
    const ownName = this.deps.getOwnName();
    if (own !== undefined && ownName !== undefined) names.set(own, ownName);
    for (const { deviceId, advert } of this.deps.listKnownDevices()) {
      const issuer = issuers.get(deviceId);
      if (issuer === undefined || names.has(issuer)) continue;
      const claim = this.deps.readNameClaim(advert);
      if (claim === undefined) continue;
      const name = await this.nameFor(claim, issuer);
      if (name !== undefined) names.set(issuer, name);
    }
    return names;
  }

  private async nameFor(
    claim: string,
    subject: string,
  ): Promise<string | undefined> {
    const cached = this.names.get(claim);
    if (cached?.subject === subject && cached.until > Date.now()) {
      return cached.name;
    }
    const verdict = await this.deps.verifyName({ claim, subject });
    remember(
      this.names,
      claim,
      verdict.ok
        ? { subject, name: verdict.name, until: verdict.expires }
        : { subject, name: undefined, until: Number.POSITIVE_INFINITY },
    );
    return verdict.ok ? verdict.name : undefined;
  }

  private async issuerFor(
    proof: string,
    deviceHex: string,
  ): Promise<string | undefined> {
    const cached = this.verdicts.get(proof);
    if (cached?.deviceHex === deviceHex && cached.until > Date.now()) {
      return cached.issuer;
    }
    let verdict: IdentifiedMembershipProof;
    try {
      verdict = await this.deps.identify({ proof, deviceHex });
    } catch (err) {
      // Not remembered: the failure is in this side's own view (a revocation view that threw, say), not a verdict on the proof, so the next listing tries again.
      this.deps.onError(
        new Error(
          `could not identify the ${this.deps.field} proof of ${deviceHex}`,
          {
            cause: err,
          },
        ),
      );
      return undefined;
    }
    remember(
      this.verdicts,
      proof,
      verdict.ok
        ? { deviceHex, issuer: verdict.issuerHex, until: verdict.expires }
        : { deviceHex, issuer: undefined, until: Number.POSITIVE_INFINITY },
    );
    return verdict.ok ? verdict.issuerHex : undefined;
  }
}

/** Records verdict under key, evicting the oldest entry once the cache holds more than VERDICT_CACHE_LIMIT. */
function remember<V>(cache: Map<string, V>, key: string, verdict: V): void {
  cache.delete(key);
  cache.set(key, verdict);
  if (cache.size > VERDICT_CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done !== true) cache.delete(oldest.value);
  }
}

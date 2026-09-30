/**
 * Which machine each listed agent runs on (agent-comms#343), for list_agents' machine-grouped output. This device's own machine is known directly; every other device's is read from the machine proof in its gossiped agent/self advert and identified cryptographically (membership-proof.ts's identifyMembershipProofIssuer), so a device is grouped under a machine only when that machine's key signed a current proof for it. A device with no such proof (a hidden agent, which sends no agent/self advert, or a bridge that predates machine proofs) has no machine here.
 *
 * The same pass reads each machine's self display name claim (agent-comms#345) from the adverts of the devices it vouches for, and keeps a name only when the claim is signed by that very machine's key: the issuer is authentic, the content is the machine's own choice.
 *
 * Grouping is display, not trust: a proof names who vouches for a device id, not that the device gossiping it is that device, so nothing here is used to authorise anything. Identifying a proof is cryptography, so verdicts are remembered per proof text until the proof lapses, and the cache is bounded. For the same reason a failure to identify one proof is reported and leaves that device unplaced rather than failing the listing it feeds.
 */

import {
  readMachineNameClaim,
  readMembershipProof,
} from "./gossip-directory.js";
import type { IdentifiedMembershipProof } from "./membership-proof.js";
import type { NameClaimVerdict } from "./name-claim.js";

/** The most proofs, and separately the most name claims, whose verdict is remembered. */
const VERDICT_CACHE_LIMIT = 1024;

export interface MachineGroupingDeps {
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
  /** This host's own machine id (hex), undefined before the store's identity is attached. */
  getMachineId: () => string | undefined;
  /** Where a proof that could not be identified at all (identify rejected) is reported. */
  onError: (error: Error) => void;
  /** Verifies a gossiped name claim about subject (name-claim.ts's verifyNameClaim, as this node sees it). */
  verifyName: (
    claim: Readonly<{ claim: string; subject: string }>,
  ) => Promise<NameClaimVerdict>;
  /** This host's own machine name, read locally. */
  getOwnMachineName: () => string | undefined;
}

interface CachedName {
  subject: string;
  name: string | undefined;
  until: number;
}

interface CachedVerdict {
  deviceHex: string;
  /** The machine the proof names, undefined for a proof that did not verify. */
  machine: string | undefined;
  /** When the verdict stops holding (epoch ms): the proof's own expiry, or never for a refusal, since the same text can never become valid later. */
  until: number;
}

export class MachineGrouping {
  private readonly verdicts = new Map<string, CachedVerdict>();
  private readonly names = new Map<string, CachedName>();

  constructor(private readonly deps: Readonly<MachineGroupingDeps>) {}

  /** The machine (hex) of each device this side can place on one, keyed by device id: this device's own, and every gossiped device with a current, valid machine proof. */
  async machinesByDevice(): Promise<Map<string, string>> {
    const machines = new Map<string, string>();
    const own = this.deps.getMachineId();
    // Without an identity attached there is no clock or revocation view to identify a proof against, and no own machine either.
    if (own === undefined) return machines;
    machines.set(this.deps.getPeerId(), own);
    for (const { deviceId, advert } of this.deps.listKnownDevices()) {
      if (machines.has(deviceId)) continue;
      const proof = readMembershipProof(advert, "machine");
      if (proof === undefined) continue;
      const machine = await this.machineFor(proof, deviceId);
      if (machine !== undefined) machines.set(deviceId, machine);
    }
    return machines;
  }

  /** The self display name of each machine this side can place a device on, keyed by machine id: this host's own from its file, every other one from a claim its own key signed, gossiped by a device it vouches for. */
  async machineNames(): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const machines = await this.machinesByDevice();
    const own = this.deps.getMachineId();
    const ownName = this.deps.getOwnMachineName();
    if (own !== undefined && ownName !== undefined) names.set(own, ownName);
    for (const { deviceId, advert } of this.deps.listKnownDevices()) {
      const machine = machines.get(deviceId);
      if (machine === undefined || names.has(machine)) continue;
      const claim = readMachineNameClaim(advert);
      if (claim === undefined) continue;
      const name = await this.nameFor(claim, machine);
      if (name !== undefined) names.set(machine, name);
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

  private async machineFor(
    proof: string,
    deviceHex: string,
  ): Promise<string | undefined> {
    const cached = this.verdicts.get(proof);
    if (cached?.deviceHex === deviceHex && cached.until > Date.now()) {
      return cached.machine;
    }
    let verdict: IdentifiedMembershipProof;
    try {
      verdict = await this.deps.identify({ proof, deviceHex });
    } catch (err) {
      // Not remembered: the failure is in this side's own view (a revocation view that threw, say), not a verdict on the proof, so the next listing tries again.
      this.deps.onError(
        new Error(`could not identify the machine proof of ${deviceHex}`, {
          cause: err,
        }),
      );
      return undefined;
    }
    remember(
      this.verdicts,
      proof,
      verdict.ok
        ? { deviceHex, machine: verdict.issuerHex, until: verdict.expires }
        : { deviceHex, machine: undefined, until: Number.POSITIVE_INFINITY },
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

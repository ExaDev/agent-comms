/**
 * Which machine each listed agent runs on (agent-comms#343), for list_agents' machine-grouped output. This device's own machine is known directly; every other device's is read from the machine proof in its gossiped agent/self advert and identified cryptographically (membership-proof.ts's identifyMembershipProofIssuer), so a device is grouped under a machine only when that machine's key signed a current proof for it. A device with no such proof (a hidden agent, which sends no agent/self advert, or a bridge that predates machine proofs) has no machine here.
 *
 * Grouping is display, not trust: a proof names who vouches for a device id, not that the device gossiping it is that device, so nothing here is used to authorise anything. Identifying a proof is cryptography, so verdicts are remembered per proof text until the proof lapses, and the cache is bounded.
 */

import { readMembershipProof } from "./gossip-directory.js";
import type { IdentifiedMembershipProof } from "./membership-proof.js";

/** The most proofs whose verdict is remembered. */
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

  private async machineFor(
    proof: string,
    deviceHex: string,
  ): Promise<string | undefined> {
    const cached = this.verdicts.get(proof);
    if (cached?.deviceHex === deviceHex && cached.until > Date.now()) {
      return cached.machine;
    }
    const verdict = await this.deps.identify({ proof, deviceHex });
    this.remember(
      proof,
      verdict.ok
        ? { deviceHex, machine: verdict.issuerHex, until: verdict.expires }
        : { deviceHex, machine: undefined, until: Number.POSITIVE_INFINITY },
    );
    return verdict.ok ? verdict.issuerHex : undefined;
  }

  private remember(proof: string, verdict: Readonly<CachedVerdict>): void {
    this.verdicts.delete(proof);
    this.verdicts.set(proof, verdict);
    if (this.verdicts.size > VERDICT_CACHE_LIMIT) {
      const oldest = this.verdicts.keys().next();
      if (oldest.done !== true) this.verdicts.delete(oldest.value);
    }
  }
}

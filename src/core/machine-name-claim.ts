/**
 * This host's self display name claim (agent-comms#345), kept fresh beside the machine proof: re-minted on the proofs' own cadence from whatever name machine-identity.json currently holds, so a name set or cleared by any bridge on the host reaches every bridge's advert within one refresh, and the setting bridge's at once.
 */

import { loadMachineDisplayName } from "./machine-identity.js";
import type { MeshStoreIdentity } from "./mesh-store-shared.js";
import { MEMBERSHIP_PROOF_LIFETIME_MS } from "./membership-proof.js";
import { PROOF_REFRESH_INTERVAL_MS } from "./membership-proofs.js";
import { mintNameClaim } from "./name-claim.js";

export interface MachineNameClaimDeps {
  /** Throws if the store has no identity yet. */
  getIdentity: () => MeshStoreIdentity;
  onError: (error: Error) => void;
}

export class MachineNameClaim {
  private claim: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: Readonly<MachineNameClaimDeps>) {}

  /** The current claim, undefined while the machine has no name or before the first claim is minted. */
  current(): string | undefined {
    return this.claim;
  }

  start(): void {
    this.stop();
    void this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, PROOF_REFRESH_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Re-reads the machine's name and re-mints its claim now; drops the claim when the machine has no name. A failed mint is reported and the previous claim is kept until the next refresh. */
  async refresh(): Promise<void> {
    const identity = this.deps.getIdentity();
    const name = loadMachineDisplayName(identity.machineIdentityOptions);
    if (name === undefined) {
      this.claim = undefined;
      return;
    }
    try {
      this.claim = await mintNameClaim({
        issuer: identity.machineIdentity,
        clock: identity.clock,
        name,
        lifetimeMs: MEMBERSHIP_PROOF_LIFETIME_MS,
      });
    } catch (error) {
      this.deps.onError(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }
}

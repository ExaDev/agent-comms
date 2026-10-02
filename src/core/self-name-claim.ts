/**
 * One grouping issuer's self display name claim (agent-comms#345 for the machine, agent-comms#359 for the user principal), kept fresh beside that issuer's proof: re-minted on the proofs' own cadence from whatever name the issuer's identity file currently holds, so a name set or cleared by any bridge on the host reaches every bridge's advert within one refresh, and the setting bridge's at once.
 */

import type { IdentityPort } from "wire-mesh-core/ports/identity";
import type { MeshStoreIdentity } from "./mesh-store-shared.js";
import { MEMBERSHIP_PROOF_LIFETIME_MS } from "./membership-proof.js";
import { PROOF_REFRESH_INTERVAL_MS } from "./membership-proofs.js";
import { mintNameClaim } from "./name-claim.js";

export interface SelfNameClaimDeps {
  /** Throws if the store has no identity yet. */
  getIdentity: () => MeshStoreIdentity;
  /** The issuer this instance signs its claim as, picked out of the store's identity: its user principal or its machine. */
  issuerOf: (identity: Readonly<MeshStoreIdentity>) => IdentityPort;
  /** The name the issuer currently asserts for itself, read from its identity file; undefined when it has none. */
  loadName: (identity: Readonly<MeshStoreIdentity>) => string | undefined;
  onError: (error: Error) => void;
}

export class SelfNameClaim {
  private claim: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: Readonly<SelfNameClaimDeps>) {}

  /** The current claim, undefined while the issuer has no name or before the first claim is minted. */
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

  /** Re-reads the issuer's name and re-mints its claim now; drops the claim when the issuer has no name. A failed mint is reported and the previous claim is kept until the next refresh. */
  async refresh(): Promise<void> {
    const identity = this.deps.getIdentity();
    const name = this.deps.loadName(identity);
    if (name === undefined) {
      this.claim = undefined;
      return;
    }
    try {
      this.claim = await mintNameClaim({
        issuer: this.deps.issuerOf(identity),
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

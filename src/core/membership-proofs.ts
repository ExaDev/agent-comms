/**
 * A device's own membership proof, kept fresh, and the check for other devices' proofs (agent-comms#266). Split out of MeshStore, which hands it its identity, peer id and error sink.
 */

import { deviceIdFromHex } from "wire-mesh-core/domain/device-id";
import type { MeshStoreIdentity } from "./mesh-store-shared.js";
import {
  MEMBERSHIP_PROOF_LIFETIME_MS,
  mintMembershipProof,
  verifyMembershipProof,
  type MembershipProofVerdict,
} from "./membership-proof.js";

/** How many times per proof lifetime the proof is re-minted, so a missed tick or two never lets the advertised proof lapse. */
const REFRESHES_PER_LIFETIME = 3;
const REFRESH_INTERVAL_MS =
  MEMBERSHIP_PROOF_LIFETIME_MS / REFRESHES_PER_LIFETIME;

export interface MembershipProofsDeps {
  /** Throws if the store has no identity yet. */
  getIdentity: () => MeshStoreIdentity;
  /** This device's own id (hex). */
  getPeerId: () => string;
  onError: (error: Error) => void;
}

export class MembershipProofs {
  private proof: string | undefined;
  private minting = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: Readonly<MembershipProofsDeps>) {}

  /** The agent/self advert field carrying this device's current proof, empty until the first has been minted. */
  advertField(): { membership?: string } {
    return this.proof === undefined ? {} : { membership: this.proof };
  }

  /** Mints a proof now and again on an interval. A failed mint is reported and retried on the next tick; the previous proof stays until it lapses. */
  start(): void {
    this.stop();
    this.refresh();
    this.timer = setInterval(() => {
      this.refresh();
    }, REFRESH_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Whether a gossiped proof shows that principalHex vouches for deviceHex, as this node sees it: its own identity, clock and revocation view. */
  async verify(
    claim: Readonly<{ proof: string; deviceHex: string; principalHex: string }>,
  ): Promise<MembershipProofVerdict> {
    const { identity, clock, revocation } = this.deps.getIdentity();
    return verifyMembershipProof({
      proof: claim.proof,
      deviceId: deviceIdFromHex(claim.deviceHex),
      principalId: deviceIdFromHex(claim.principalHex),
      identity,
      clock,
      revocation,
    });
  }

  private refresh(): void {
    if (this.minting) return;
    this.minting = true;
    const { userIdentity, clock } = this.deps.getIdentity();
    mintMembershipProof({
      userIdentity,
      clock,
      deviceId: deviceIdFromHex(this.deps.getPeerId()),
    })
      .then(
        (proof) => {
          this.proof = proof;
        },
        (error: unknown) => {
          this.deps.onError(
            error instanceof Error ? error : new Error(String(error)),
          );
        },
      )
      .finally(() => {
        this.minting = false;
      });
  }
}

/**
 * A device's own membership proof under one grouping issuer, kept fresh, and the checks for other devices' proofs (agent-comms#266, agent-comms#343). MeshStore holds one instance per issuer, its user principal and its machine, and hands each its identity, peer id and error sink. The checks do not depend on which issuer an instance mints under, so either instance can verify or identify any proof.
 */

import type { IdentityPort } from "wire-mesh-core/ports/identity";
import {
  deviceIdFromHex,
  deviceIdToHex,
} from "wire-mesh-core/domain/device-id";
import type { MeshStoreIdentity } from "./mesh-store-shared.js";
import {
  MEMBERSHIP_PROOF_LIFETIME_MS,
  identifyMembershipProofIssuer,
  mintMembershipProof,
  verifyMembershipProof,
  type IdentifiedMembershipProof,
  type MembershipProofVerdict,
} from "./membership-proof.js";

/** How many times per proof lifetime the proof is re-minted, so a missed tick or two never lets the advertised proof lapse. */
const REFRESHES_PER_LIFETIME = 3;
/** How often an advertised proof, or a name claim riding beside it, is re-minted. */
export const PROOF_REFRESH_INTERVAL_MS =
  MEMBERSHIP_PROOF_LIFETIME_MS / REFRESHES_PER_LIFETIME;

export interface MembershipProofsDeps {
  /** Throws if the store has no identity yet. */
  getIdentity: () => MeshStoreIdentity;
  /** The issuer this instance mints under, picked out of the store's identity: its user principal or its machine. */
  issuerOf: (identity: Readonly<MeshStoreIdentity>) => IdentityPort;
  /** This device's own id (hex). */
  getPeerId: () => string;
  onError: (error: Error) => void;
}

/** The last account-membership verdict for one device: which proof it was about, against which principal, and until when a positive one holds. */
interface AccountMemberVerdict {
  proof: string;
  principal: string;
  /** Epoch ms after which a positive verdict needs checking again; a negative one never changes for the same proof and principal. */
  until: number | undefined;
}

export class MembershipProofs {
  private proof: string | undefined;
  private minting = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Keyed by device-id hex. One entry per device this side has checked, replaced whenever that device's proof or this side's principal changes. */
  private readonly accountVerdicts = new Map<string, AccountMemberVerdict>();

  constructor(private readonly deps: Readonly<MembershipProofsDeps>) {}

  /** This device's current proof, undefined until the first has been minted. */
  current(): string | undefined {
    return this.proof;
  }

  /** Mints a proof now and again on an interval. A failed mint is reported and retried on the next tick; the previous proof stays until it lapses. */
  start(): void {
    this.stop();
    this.refresh();
    this.timer = setInterval(() => {
      this.refresh();
    }, PROOF_REFRESH_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Whether a gossiped proof shows that issuerHex vouches for deviceHex, as this node sees it: its own identity, clock and revocation view. */
  async verify(
    claim: Readonly<{ proof: string; deviceHex: string; issuerHex: string }>,
  ): Promise<MembershipProofVerdict> {
    const { identity, clock, revocation } = this.deps.getIdentity();
    return verifyMembershipProof({
      proof: claim.proof,
      deviceId: deviceIdFromHex(claim.deviceHex),
      issuerId: deviceIdFromHex(claim.issuerHex),
      identity,
      clock,
      revocation,
    });
  }

  /** Whether a gossiped proof shows that deviceHex belongs to the account this store holds: the proof verifies against this store's own user principal. A verdict is remembered per device, so a device re-gossiping the same proof is not re-verified on every advert; a positive one is trusted only until its proof expires, a negative one for as long as the proof and this side's principal are unchanged. */
  async isAccountMember(
    claim: Readonly<{ proof: string; deviceHex: string }>,
  ): Promise<boolean> {
    const { userIdentity, clock } = this.deps.getIdentity();
    const principal = deviceIdToHex(userIdentity.deviceId);
    const known = this.accountVerdicts.get(claim.deviceHex);
    if (known?.proof === claim.proof && known.principal === principal) {
      if (known.until === undefined) return false;
      if (known.until > clock.now()) return true;
    }
    const verdict = await this.verify({
      proof: claim.proof,
      deviceHex: claim.deviceHex,
      issuerHex: principal,
    });
    this.accountVerdicts.set(claim.deviceHex, {
      proof: claim.proof,
      principal,
      until: verdict.ok ? verdict.expires : undefined,
    });
    return verdict.ok;
  }

  /** Which issuer a gossiped proof shows vouching for deviceHex, as this node sees it. */
  async identify(
    claim: Readonly<{ proof: string; deviceHex: string }>,
  ): Promise<IdentifiedMembershipProof> {
    const { identity, clock, revocation } = this.deps.getIdentity();
    return identifyMembershipProofIssuer({
      proof: claim.proof,
      deviceId: deviceIdFromHex(claim.deviceHex),
      identity,
      clock,
      revocation,
    });
  }

  private refresh(): void {
    if (this.minting) return;
    this.minting = true;
    const storeIdentity = this.deps.getIdentity();
    mintMembershipProof({
      issuer: this.deps.issuerOf(storeIdentity),
      clock: storeIdentity.clock,
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

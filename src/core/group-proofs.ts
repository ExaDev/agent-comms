/**
 * This device's membership proofs under both of its grouping issuers, its user principal (agent-comms#266) and its machine (agent-comms#343), with the checks for other devices' proofs and the machine grouping list_agents shows. Split out of MeshStore, which hands it its identity, peer id, transport and error sink.
 */

import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import type { MeshStoreIdentity } from "./mesh-store-shared.js";
import type { MeshTransport } from "./transport.js";
import { MembershipProofs } from "./membership-proofs.js";
import { MachineGrouping } from "./machine-grouping.js";
import type { AgentSelfSummary } from "./gossip-extensions.js";
import type {
  IdentifiedMembershipProof,
  MembershipProofVerdict,
} from "./membership-proof.js";

export interface GroupProofsDeps {
  /** Throws if the store has no identity yet. */
  getIdentity: () => MeshStoreIdentity;
  /** This store's identity, or undefined before it is attached. */
  peekIdentity: () => MeshStoreIdentity | undefined;
  /** This device's own id (hex). */
  getPeerId: () => string;
  /** Throws if the store has no transport yet. */
  requireTransport: () => MeshTransport;
  onError: (error: Error) => void;
}

export class GroupProofs {
  private readonly principal: MembershipProofs;
  private readonly machine: MembershipProofs;
  private readonly grouping: MachineGrouping;

  constructor(deps: Readonly<GroupProofsDeps>) {
    const shared = {
      getIdentity: deps.getIdentity,
      getPeerId: deps.getPeerId,
      onError: deps.onError,
    };
    this.principal = new MembershipProofs({
      ...shared,
      issuerOf: (identity) => identity.userIdentity,
    });
    this.machine = new MembershipProofs({
      ...shared,
      issuerOf: (identity) => identity.machineIdentity,
    });
    this.grouping = new MachineGrouping({
      listKnownDevices: () =>
        deps.requireTransport().listKnownDevices?.() ?? [],
      identify: async (claim) => this.identify(claim),
      getPeerId: deps.getPeerId,
      getMachineId: () => {
        const identity = deps.peekIdentity();
        return identity === undefined
          ? undefined
          : deviceIdToHex(identity.machineIdentity.deviceId);
      },
      onError: deps.onError,
    });
  }

  /** The agent/self advert fields carrying this device's current proofs, each absent until it has first been minted. */
  advertFields(): Pick<AgentSelfSummary, "membership" | "machine"> {
    const membership = this.principal.current();
    const machine = this.machine.current();
    return {
      ...(membership !== undefined ? { membership } : {}),
      ...(machine !== undefined ? { machine } : {}),
    };
  }

  /** Starts keeping both proofs fresh; called once the store's identity is attached. */
  start(): void {
    this.principal.start();
    this.machine.start();
  }

  stop(): void {
    this.principal.stop();
    this.machine.stop();
  }

  /** Whether a gossiped proof shows that issuerHex, a principal or a machine, vouches for deviceHex. */
  async verify(
    claim: Readonly<{ proof: string; deviceHex: string; issuerHex: string }>,
  ): Promise<MembershipProofVerdict> {
    return this.principal.verify(claim);
  }

  /** Which issuer a gossiped proof shows vouching for deviceHex. Verification does not depend on which issuer an instance mints under, so the principal's instance serves for both. */
  async identify(
    claim: Readonly<{ proof: string; deviceHex: string }>,
  ): Promise<IdentifiedMembershipProof> {
    return this.principal.identify(claim);
  }

  /** The machine (hex) of each device this side can place on one, keyed by device id. */
  async machinesByDevice(): Promise<Map<string, string>> {
    return this.grouping.machinesByDevice();
  }
}

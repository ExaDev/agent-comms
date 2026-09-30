/**
 * This device's membership proofs under both of its grouping issuers, its user principal (agent-comms#266) and its machine (agent-comms#343), and the machine's self display name claim (agent-comms#345), with the checks for other devices' proofs and claims and the machine grouping and names list_agents shows. Split out of MeshStore, which hands it its identity, peer id, transport and error sink.
 */

import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import type { MeshStoreIdentity } from "./mesh-store-shared.js";
import type { MeshTransport } from "./transport.js";
import { MembershipProofs } from "./membership-proofs.js";
import { MachineGrouping } from "./machine-grouping.js";
import { MachineNameClaim } from "./machine-name-claim.js";
import {
  loadMachineDisplayName,
  saveMachineDisplayName,
} from "./machine-identity.js";
import { verifyNameClaim } from "./name-claim.js";
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
  private readonly machineName: MachineNameClaim;
  private readonly getIdentity: () => MeshStoreIdentity;

  constructor(deps: Readonly<GroupProofsDeps>) {
    this.getIdentity = deps.getIdentity;
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
      verifyName: async ({ claim, subject }) => {
        const { identity, clock } = deps.getIdentity();
        return verifyNameClaim({ claim, subject, identity, clock });
      },
      getOwnMachineName: () => {
        const identity = deps.peekIdentity();
        return identity === undefined
          ? undefined
          : loadMachineDisplayName(identity.machineIdentityOptions);
      },
    });
    this.machineName = new MachineNameClaim({
      getIdentity: deps.getIdentity,
      onError: deps.onError,
    });
  }

  /** The agent/self advert fields carrying this device's current proofs, each absent until it has first been minted. */
  advertFields(): Pick<
    AgentSelfSummary,
    "membership" | "machine" | "machineName"
  > {
    const membership = this.principal.current();
    const machine = this.machine.current();
    const machineName = this.machineName.current();
    return {
      ...(membership !== undefined ? { membership } : {}),
      ...(machine !== undefined ? { machine } : {}),
      ...(machineName !== undefined ? { machineName } : {}),
    };
  }

  /** Starts keeping both proofs fresh; called once the store's identity is attached. */
  start(): void {
    this.principal.start();
    this.machine.start();
    this.machineName.start();
  }

  stop(): void {
    this.principal.stop();
    this.machine.stop();
    this.machineName.stop();
  }

  /** Sets (or, given undefined, clears) this machine's self display name and re-mints its claim now rather than on the next refresh. Throws if the store has no identity yet. */
  async saveMachineName(name: string | undefined): Promise<void> {
    saveMachineDisplayName(this.getIdentity().machineIdentityOptions, name);
    return this.machineName.refresh();
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

  /** The self display name of each machine this side can place a device on, keyed by machine id. */
  async machineNames(): Promise<Map<string, string>> {
    return this.grouping.machineNames();
  }
}

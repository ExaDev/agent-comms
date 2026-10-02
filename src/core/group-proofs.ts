/**
 * This device's membership proofs under both of its grouping issuers, its user principal (agent-comms#266) and its machine (agent-comms#343), and the self display name claims of both (agent-comms#345 for the machine, agent-comms#359 for the principal), with the checks for other devices' proofs and claims and the machine grouping and names list_agents shows. Split out of MeshStore, which hands it its identity, peer id, transport and error sink.
 */

import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import type { MeshStoreIdentity } from "./mesh-store-shared.js";
import type { MeshTransport } from "./transport.js";
import { MembershipProofs } from "./membership-proofs.js";
import { IssuerGrouping } from "./issuer-grouping.js";
import { SelfNameClaim } from "./self-name-claim.js";
import {
  loadMachineDisplayName,
  saveMachineDisplayName,
} from "./machine-identity.js";
import { readNameClaim } from "./gossip-directory.js";
import { verifyNameClaim } from "./name-claim.js";
import { loadUserDisplayName, saveUserDisplayName } from "./user-identity.js";
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
  private readonly machineGrouping: IssuerGrouping;
  private readonly principalGrouping: IssuerGrouping;
  private readonly machineName: SelfNameClaim;
  private readonly principalName: SelfNameClaim;
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
    const grouping = {
      listKnownDevices: () =>
        deps.requireTransport().listKnownDevices?.() ?? [],
      identify: async (claim: Readonly<{ proof: string; deviceHex: string }>) =>
        this.identify(claim),
      getPeerId: deps.getPeerId,
      onError: deps.onError,
      verifyName: async (
        claim: Readonly<{ claim: string; subject: string }>,
      ) => {
        const { identity, clock } = deps.getIdentity();
        return verifyNameClaim({
          claim: claim.claim,
          subject: claim.subject,
          identity,
          clock,
        });
      },
    };
    this.machineGrouping = new IssuerGrouping({
      ...grouping,
      field: "machine",
      readNameClaim: (advert) => readNameClaim(advert, "machineName"),
      getOwnIssuerId: () => {
        const identity = deps.peekIdentity();
        return identity === undefined
          ? undefined
          : deviceIdToHex(identity.machineIdentity.deviceId);
      },
      getOwnName: () => {
        const identity = deps.peekIdentity();
        return identity === undefined
          ? undefined
          : loadMachineDisplayName(identity.machineIdentityOptions);
      },
    });
    this.principalGrouping = new IssuerGrouping({
      ...grouping,
      field: "membership",
      readNameClaim: (advert) => readNameClaim(advert, "principalName"),
      getOwnIssuerId: () => {
        const identity = deps.peekIdentity();
        return identity === undefined
          ? undefined
          : deviceIdToHex(identity.userIdentity.deviceId);
      },
      getOwnName: () => {
        const identity = deps.peekIdentity();
        return identity === undefined
          ? undefined
          : loadUserDisplayName(identity.userIdentityOptions);
      },
    });
    this.machineName = new SelfNameClaim({
      getIdentity: deps.getIdentity,
      issuerOf: (identity) => identity.machineIdentity,
      loadName: (identity) =>
        loadMachineDisplayName(identity.machineIdentityOptions),
      onError: deps.onError,
    });
    this.principalName = new SelfNameClaim({
      getIdentity: deps.getIdentity,
      issuerOf: (identity) => identity.userIdentity,
      loadName: (identity) => loadUserDisplayName(identity.userIdentityOptions),
      onError: deps.onError,
    });
  }

  /** Whether a gossiped proof shows that deviceHex belongs to the account this store holds, judged against the user principal's own proofs (MembershipProofs.isAccountMember). */
  async isAccountMember(
    claim: Readonly<{ proof: string; deviceHex: string }>,
  ): Promise<boolean> {
    return this.principal.isAccountMember(claim);
  }

  /** The agent/self advert fields carrying this device's current proofs, each absent until it has first been minted. */
  advertFields(): Pick<
    AgentSelfSummary,
    "membership" | "machine" | "machineName" | "principalName"
  > {
    const membership = this.principal.current();
    const machine = this.machine.current();
    const machineName = this.machineName.current();
    const principalName = this.principalName.current();
    return {
      ...(membership !== undefined ? { membership } : {}),
      ...(machine !== undefined ? { machine } : {}),
      ...(machineName !== undefined ? { machineName } : {}),
      ...(principalName !== undefined ? { principalName } : {}),
    };
  }

  /** Starts keeping both proofs and both name claims fresh; called once the store's identity is attached. */
  start(): void {
    this.principal.start();
    this.machine.start();
    this.machineName.start();
    this.principalName.start();
  }

  stop(): void {
    this.principal.stop();
    this.machine.stop();
    this.machineName.stop();
    this.principalName.stop();
  }

  /** Sets (or, given undefined, clears) this machine's self display name and re-mints its claim now rather than on the next refresh. Throws if the store has no identity yet. */
  async saveMachineName(name: string | undefined): Promise<void> {
    saveMachineDisplayName(this.getIdentity().machineIdentityOptions, name);
    return this.machineName.refresh();
  }

  /** Sets (or, given undefined, clears) this account's self display name and re-mints its claim now rather than on the next refresh. Throws if the store has no identity yet. */
  async saveUserName(name: string | undefined): Promise<void> {
    saveUserDisplayName(this.getIdentity().userIdentityOptions, name);
    return this.principalName.refresh();
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
    return this.machineGrouping.issuersByDevice();
  }

  /** The self display name of each grouping issuer this side can place a device under, machines and user principals together, keyed by issuer id. The two kinds of id never collide, since each is the hash of a different key. */
  async issuerNames(): Promise<Map<string, string>> {
    return new Map([
      ...(await this.machineGrouping.issuerNames()),
      ...(await this.principalGrouping.issuerNames()),
    ]);
  }
}

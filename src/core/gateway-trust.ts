/**
 * GatewayTrust -- the cross-machine trust boundary (agent-comms#156, agent-comms#153's third leg): an allowlist of remote device-ids this machine's gateway will advertise its local agents to, accept forwarded hub traffic from, and route outbound hub requests to. Deny-all by default: empty until an operator explicitly trusts at least one remote device, the same no-CA pin-the-key model ordinary peer connections already use.
 *
 * Shared by every store on the machine when constructed with an identity location (agent-comms#186, made machine-wide by agent-comms#293): the trusted set lives in one JSON file per identity directory (identity-store.ts's loadGatewayTrust), because who may see and reach this user's agents from another machine is an operator decision about the machine, and every store on it advertises itself under that decision, including each Claude Code session the default cc-peer front handles, which has no operator of its own to run gateway_trust. Every process on the machine reads and writes that one file, so each read below first checks whether another process has replaced it (gatewayTrustStamp) and reloads if so, and each change reloads, applies itself, and writes back in full, so an add made in one bridge is seen by the others on their next check. Two processes changing the file within the same instant can still lose one of the two changes, since there is no cross-process lock; changes are rare operator actions, so that window is accepted. Constructed with no location, this class keeps the original v1 FederationManager.trustedFingerprints precedent (retired with federation.ts, commit 4232b08): in-memory only, never touching disk, which is what most tests use.
 *
 * Keyed by individual device-id, not by "one entry per remote machine": wire-mesh-core's relay-hub protocol (relay-hub.ts, gossip-frame, relay-data-frame) carries no field identifying which remote gateway connection a given directory entry or relayed request actually originated from -- only the entry/request's own device-id, which may be an ordinary local peer forwarded on a remote machine's behalf rather than that machine's own coordinator. Gating per individual device-id is therefore the finest-grained, and only wire-protocol-honest, trust boundary actually implementable without a wire-mesh-core protocol change (deliberately out of scope here, matching agent-comms#156's own "gating the hub itself is out of scope" framing) -- confirmed as the intended granularity by hub-session.ts's own pre-existing isStateMutatingMessage doc comment, which already named this exact gap as "agent-comms#156's own future deliverable" of "per-peer" admission control. An operator who wants every local peer on a remote machine reachable trusts each of that machine's device-ids individually, not just its coordinator's.
 *
 * Machine-keyed trust (agent-comms#343) is the same shape as the principal's: a machine is another grouping issuer (machine-identity.ts), so trusting one makes every device its gossiped proofs vouch for reachable, and untrusting it cuts all of them off at once, which is how every bridge one account runs on a host is revoked in one act (the key is per OS account, machine-identity.ts). Principals and machines are separate sets because they answer different questions (whose device, which host), and a device may be vouched for by one of each.
 *
 * Principal-keyed trust (agent-comms#187): alongside the bare-device allowlist above, an operator may also trust a user-principal device-id (user-identity.ts) directly -- the root a remote peer's own dm:send-style delegation chain can terminate at, verified the same way device-membership-verification.ts already verifies a device's own group:member chain (`verifyCapabilityToken`'s chain-walk and its `rootIssuer` output). This is purely a second, parallel allowlist: `isTrusted`/`add`/`remove`/`list` keep checking only the bare-device set, unchanged, for a peer with no principal at all -- `isTrustedFor` is the additive entrypoint a caller who has already chain-verified a token uses to decide trust from that verified bearer and chain-root pair, accepting either a directly trusted device or a bearer rooted at a trusted principal. Persisted alongside the bare-device set (agent-comms#186's own persistence, extended here per that issue's own "agent-comms#187 covers what gets stored" framing): loadGatewayTrust/saveGatewayTrust now carry both sets.
 */
import type { Clock } from "wire-mesh-core/ports/clock";
import { createSystemClock } from "wire-mesh-core/adapters/system-clock";
import type { IdentitySlot, LoadedGatewayTrust } from "./identity-store.js";
import {
  gatewayTrustStamp,
  loadGatewayTrust,
  saveGatewayTrust,
} from "./identity-store.js";

const MS_PER_SECOND = 1000;
const TRUST_FILE_RECHECK_INTERVAL_SECONDS = 1;

/**
 * How long a read decision may rest on the last look at the trust file before the file is looked at again.
 *
 * Every directory entry a node merges asks the trust boundary several questions, so a hub node answers them thousands of times a second, and each used to cost a `stat`. This bound makes the cost one `stat` per interval. It is the longest another process's revocation can go unseen by a read, so it is chosen against the slowest thing a revocation already waits for: a device merged into the directory stays there until the next presence re-advertisement, many seconds on, so a one second bound adds no delay a user could observe to that path while leaving the check far below the rate at which it was being run. Writes never rely on it: each re-reads the file first, so one process cannot overwrite another's change.
 */
export const TRUST_FILE_RECHECK_INTERVAL_MS =
  TRUST_FILE_RECHECK_INTERVAL_SECONDS * MS_PER_SECOND;

/** The read-only slice of GatewayTrust every consumer of the trust boundary actually needs (WireMeshTransport, HubSession, hub-forwarding.ts) -- named so call sites that only ever read trust decisions, never mutate them, don't repeat the same `Pick<GatewayTrust, "isTrusted" | "hasAny" | "isTrustedPrincipal" | "isTrustedFor">` inline at every field/parameter that takes one. */
export type GatewayTrustReader = Pick<
  GatewayTrust,
  | "isTrusted"
  | "isReachable"
  | "isVouchedBy"
  | "hasAny"
  | "isTrustedPrincipal"
  | "isTrustedFor"
  | "listPrincipals"
  | "listMachines"
  | "noteVerifiedMember"
>;

/** Which kind of grouping issuer vouches for a device: its user principal or its machine. */
export type GroupKind = "principal" | "machine";

/** A grouping issuer that vouched for a device: its kind and its device-id (lowercase hex). */
export interface Voucher {
  kind: GroupKind;
  issuer: string;
}

/** A device reachable only because a trusted issuer vouches for it, and that issuer. */
export interface VerifiedMember extends Voucher {
  device: string;
}

/** What a GatewayTrust is built from: where to persist (none for an in-memory boundary) and the clock its trust-file rechecks are paced by. */
export interface GatewayTrustOptions {
  location?: Readonly<Pick<IdentitySlot, "dir" | "dataDir">> | undefined;
  clock?: Clock | undefined;
}

export class GatewayTrust {
  private readonly trusted = new Set<string>();
  private readonly trustedIssuers: Readonly<Record<GroupKind, Set<string>>> = {
    principal: new Set<string>(),
    machine: new Set<string>(),
  };
  /** Devices whose gossiped membership proof was verified against a trusted issuer, keyed by memberKey (a device can hold one of each kind), with that issuer and when the proof lapses. In memory only: a proof is short-lived and re-verified from the next advert, so nothing here is worth persisting. */
  private readonly verifiedMembers = new Map<
    string,
    VerifiedMember & { expiresAt: number }
  >();
  private readonly location:
    Readonly<Pick<IdentitySlot, "dir" | "dataDir">> | undefined;
  /** gatewayTrustStamp as of the last load or write this instance made, so refresh() can tell when another process has replaced the file since. */
  private stamp: string | undefined;
  /** When the file's stamp was last compared, so reads can skip the comparison inside TRUST_FILE_RECHECK_INTERVAL_MS. */
  private checkedAt: number | undefined;
  private readonly clock: Clock;

  /** Constructs the trust boundary, optionally bound to an identity location for persistence (agent-comms#186); any IdentitySlot serves as one, since only its directory matters. See this class's own doc comment for what a location does and doesn't change. Given a location, immediately loads whatever devices and principals are already trusted into the in-memory sets. */
  constructor(options: Readonly<GatewayTrustOptions> = {}) {
    this.location = options.location;
    this.clock = options.clock ?? createSystemClock();
    this.load();
  }

  /** Replaces the in-memory sets with whatever the file currently holds, recording the file's stamp. A no-op without a location. Verified members are left alone: they are in memory only and are dropped on their own when their principal stops being trusted. */
  private load(): void {
    if (this.location === undefined) return;
    this.checkedAt = this.clock.now();
    this.stamp = gatewayTrustStamp(this.location);
    const loaded = loadGatewayTrust(this.location);
    this.trusted.clear();
    this.trustedIssuers.principal.clear();
    this.trustedIssuers.machine.clear();
    for (const deviceHex of loaded.devices) {
      this.trusted.add(deviceHex);
    }
    for (const principalHex of loaded.principals) {
      this.trustedIssuers.principal.add(principalHex);
    }
    for (const machineHex of loaded.machines) {
      this.trustedIssuers.machine.add(machineHex);
    }
  }

  /** Reloads from disk when another process has replaced the file since this instance last looked, looking at most once per TRUST_FILE_RECHECK_INTERVAL_MS. Called first by every method that only reads the sets, so a trust decision is never older than the file by more than that bound. */
  private refresh(): void {
    if (this.location === undefined) return;
    const now = this.clock.now();
    if (
      this.checkedAt !== undefined &&
      now - this.checkedAt < TRUST_FILE_RECHECK_INTERVAL_MS
    ) {
      return;
    }
    this.refreshNow();
  }

  /** Looks at the file now, whatever the last look was. Every method that changes the sets starts here, because it rewrites the whole file from them: starting from anything older would erase another process's change. */
  private refreshNow(): void {
    if (this.location === undefined) return;
    this.checkedAt = this.clock.now();
    if (gatewayTrustStamp(this.location) !== this.stamp) this.load();
  }

  /** Marks a remote device-id (hex, case-insensitive) as trusted: this side will merge its gossiped directory entries, dispatch its relayed requests, and route outbound hub requests to it. Idempotent. Persists the updated set when this instance was constructed with a location. */
  add(deviceHex: string): void {
    this.refreshNow();
    this.trusted.add(deviceHex.toLowerCase());
    this.persist();
  }

  /** Withdraws a previously trusted device-id (hex, case-insensitive). A no-op if it was never trusted. Requests already in flight are unaffected; a directory entry merged from the hub because of this trust alone leaves the transport's view on its next read (KnownDevices, gossip-directory.ts). Persists the updated set when this instance was constructed with a location. */
  remove(deviceHex: string): void {
    this.refreshNow();
    this.trusted.delete(deviceHex.toLowerCase());
    this.persist();
  }

  /** Writes the complete current trusted device, principal and machine sets back to the shared trust file, if this instance was constructed with a location. A no-op for the in-memory-only case. */
  private persist(): void {
    if (this.location === undefined) return;
    const trust: LoadedGatewayTrust = {
      devices: [...this.trusted],
      principals: [...this.trustedIssuers.principal],
      machines: [...this.trustedIssuers.machine],
    };
    saveGatewayTrust(this.location, trust);
    this.stamp = gatewayTrustStamp(this.location);
  }

  /** Every currently trusted device-id, lowercase hex, in insertion order. */
  list(): string[] {
    this.refresh();
    return [...this.trusted];
  }

  /** Whether the given device-id (hex, case-insensitive) is trusted by id: on the bare-device allowlist. A device trusted only because a principal or machine vouches for it (noteVerifiedMember) is not, on purpose: its proof is a claim that anyone who has read the device's gossiped advert can repeat, so it earns only what isReachable grants. */
  isTrusted(deviceHex: string): boolean {
    this.refresh();
    return this.trusted.has(deviceHex.toLowerCase());
  }

  /** Whether this side may merge the device's gossiped directory entry and route requests to it: trusted by id, or a verified member of a trusted principal or machine. Requests routed to a device are still authenticated end to end by the session inside the relay, so a false claim can misroute one (which then fails its handshake) but not read or forge one. */
  isReachable(deviceHex: string): boolean {
    this.refresh();
    const key = deviceHex.toLowerCase();
    return (
      this.trusted.has(key) ||
      this.isVerifiedMember(key, "principal") ||
      this.isVerifiedMember(key, "machine")
    );
  }

  /** Whether the device (hex, case-insensitive) is currently a verified member through a trusted issuer of the given kind: its proof of that kind has not lapsed and its issuer is still trusted. Unlike isReachable, this answers for one kind alone, so a device reachable through its principal is not taken to hold a live machine record too. */
  isVouchedBy(deviceHex: string, kind: GroupKind): boolean {
    this.refresh();
    return this.isVerifiedMember(deviceHex.toLowerCase(), kind);
  }

  /** Records that deviceHex presented a membership proof, valid until expiresAt (epoch ms), verified against voucher (agent-comms#266, agent-comms#343). From then until the proof lapses, or the voucher's issuer stops being trusted, isReachable treats the device as reachable. A later proof from the same kind of issuer never shortens an earlier one's window. The caller has already verified the proof: this class does no cryptography. */
  noteVerifiedMember(
    deviceHex: string,
    voucher: Readonly<Voucher>,
    expiresAt: number,
  ): void {
    const device = deviceHex.toLowerCase();
    const now = Date.now();
    for (const [key, member] of this.verifiedMembers) {
      if (member.expiresAt <= now) this.verifiedMembers.delete(key);
    }
    const key = memberKey(device, voucher.kind);
    const existing = this.verifiedMembers.get(key);
    this.verifiedMembers.set(key, {
      device,
      kind: voucher.kind,
      issuer: voucher.issuer.toLowerCase(),
      expiresAt: Math.max(expiresAt, existing?.expiresAt ?? 0),
    });
  }

  /** Every device currently reachable because a trusted principal or machine vouches for it, once per vouching issuer. Excludes proofs that have lapsed and members whose issuer is no longer trusted. */
  listVerifiedMembers(): VerifiedMember[] {
    this.refresh();
    return [...this.verifiedMembers.values()]
      .filter((member) => this.isVerifiedMember(member.device, member.kind))
      .map(({ device, kind, issuer }) => ({ device, kind, issuer }));
  }

  private isVerifiedMember(device: string, kind: GroupKind): boolean {
    const member = this.verifiedMembers.get(memberKey(device, kind));
    return (
      member !== undefined &&
      member.expiresAt > Date.now() &&
      this.trustedIssuers[kind].has(member.issuer)
    );
  }

  private addIssuer(kind: GroupKind, deviceHex: string): void {
    this.refreshNow();
    this.trustedIssuers[kind].add(deviceHex.toLowerCase());
    this.persist();
  }

  /** Withdraws trust from one issuer and, in the same act, from every device reachable only through it; the transport's directory drops those devices on its next read (KnownDevices, gossip-directory.ts). */
  private removeIssuer(kind: GroupKind, deviceHex: string): void {
    this.refreshNow();
    const issuer = deviceHex.toLowerCase();
    this.trustedIssuers[kind].delete(issuer);
    for (const [key, member] of this.verifiedMembers) {
      if (member.kind === kind && member.issuer === issuer) {
        this.verifiedMembers.delete(key);
      }
    }
    this.persist();
  }

  /** Marks a remote user-principal device-id (hex, case-insensitive; user-identity.ts) as trusted (agent-comms#187): a peer presenting a token whose delegation chain roots at this principal is trusted via `isTrustedFor` below, without that peer's own bare device-id ever needing individual trust, and a device whose gossiped proof this principal vouches for becomes reachable. Idempotent, and entirely independent of the bare-device allowlist `add` manages. Persists the updated set when this instance was constructed with a location. */
  addPrincipal(deviceHex: string): void {
    this.addIssuer("principal", deviceHex);
  }

  /** Withdraws a previously trusted principal (hex, case-insensitive), and every device reachable only through it. A no-op if it was never trusted. Persists the updated set when this instance was constructed with a location. */
  removePrincipal(deviceHex: string): void {
    this.removeIssuer("principal", deviceHex);
  }

  /** Every currently trusted principal device-id, lowercase hex, in insertion order. */
  listPrincipals(): string[] {
    this.refresh();
    return [...this.trustedIssuers.principal];
  }

  /** Whether the given device-id (hex, case-insensitive) is currently trusted as a user principal. */
  isTrustedPrincipal(deviceHex: string): boolean {
    this.refresh();
    return this.trustedIssuers.principal.has(deviceHex.toLowerCase());
  }

  /** Marks a remote machine device-id (hex, case-insensitive; machine-identity.ts) as trusted (agent-comms#343): every device whose gossiped proof this machine vouches for becomes reachable, without being trusted individually. Idempotent. Persists the updated set when this instance was constructed with a location. */
  addMachine(deviceHex: string): void {
    this.addIssuer("machine", deviceHex);
  }

  /** Withdraws a previously trusted machine (hex, case-insensitive), and in the same act every device reachable only because that machine vouched for it, revoking that machine key's bridges on the host. A device also trusted by id or through a trusted principal stays reachable by that route. A no-op if the machine was never trusted. Persists the updated set when this instance was constructed with a location. */
  removeMachine(deviceHex: string): void {
    this.removeIssuer("machine", deviceHex);
  }

  /** Every currently trusted machine device-id, lowercase hex, in insertion order. */
  listMachines(): string[] {
    this.refresh();
    return [...this.trustedIssuers.machine];
  }

  /**
   * Whether a peer is trusted, given a token's own bearer and chain-root device-ids (hex, case-insensitive) a caller has already chain-verified via `verifyCapabilityToken` (the same `rootIssuer` output device-membership-verification.ts's own chain check already relies on). Passes when the bearer itself is directly trusted (the existing bare-device path, unmodified for a peer with no principal at all), OR when the chain's root is a trusted principal -- so a device sub-delegated from an admitted principal (mirroring agent-comms#161's own "principal admits its own devices" pattern) is trusted without ever being individually allowlisted. This class performs no cryptographic verification itself; the caller supplies already-verified device-ids, keeping GatewayTrust the same plain allowlist it always was.
   */
  isTrustedFor(bearerHex: string, rootIssuerHex: string): boolean {
    return this.isTrusted(bearerHex) || this.isTrustedPrincipal(rootIssuerHex);
  }

  /**
   * Whether at least one remote device, principal or machine is currently trusted: the outbound gossip gate. wire-mesh-core's relay-hub broadcasts a gossiped advert to every connected hub peer with no per-recipient targeting (RelayHub.handleConnection's own "re-broadcasts each gossip frame to every other connected client"), so "advertise local agents only to allowlisted remote gateways" can only be approximated at the coarse granularity this side actually controls: don't advertise anything at all until the operator has opted in by trusting at least one remote device, principal or machine. Once true, an advertisement still reaches every hub-connected peer, trusted or not; the per-device isTrusted()/isTrustedFor() checks above are what keep this side from ACTING on anything an untrusted peer sends back, which is the boundary that actually matters.
   */
  hasAny(): boolean {
    this.refresh();
    return (
      this.trusted.size > 0 ||
      this.trustedIssuers.principal.size > 0 ||
      this.trustedIssuers.machine.size > 0
    );
  }
}

/** verifiedMembers' key: one entry per device per kind of issuer. */
function memberKey(device: string, kind: GroupKind): string {
  return `${kind}:${device}`;
}

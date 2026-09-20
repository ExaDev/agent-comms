/**
 * GatewayTrust -- the cross-machine trust boundary (agent-comms#156, agent-comms#153's third leg): an allowlist of remote device-ids this machine's gateway will advertise its local agents to, accept forwarded hub traffic from, and route outbound hub requests to. Deny-all by default: empty until an operator explicitly trusts at least one remote device, the same no-CA pin-the-key model ordinary peer connections already use.
 *
 * Persisted per bridge slot when constructed with one (agent-comms#186), mirroring identity-store.ts's own per-slot room-token/issued-grant persistence: the trusted set is loaded from that slot's own sibling JSON file (identity-store.ts's loadGatewayTrust) on construction, and written back in full (saveGatewayTrust) after every add/remove, so trust survives a gateway restart instead of needing to be re-established every run. The in-memory Set below remains the live source of truth for isTrusted/hasAny at all times; persistence is purely load-on-construct and save-on-mutate. Constructed with no slot, this class keeps the original v1 FederationManager.trustedFingerprints precedent (retired with federation.ts, commit 4232b08): in-memory only, never touching disk. Every pre-#186 construction site (most tests, and any caller with no bridge identity slot to hand) falls into this no-slot case unchanged.
 *
 * Keyed by individual device-id, not by "one entry per remote machine": wire-mesh-core's relay-hub protocol (relay-hub.ts, gossip-frame, relay-data-frame) carries no field identifying which remote gateway connection a given directory entry or relayed request actually originated from -- only the entry/request's own device-id, which may be an ordinary local peer forwarded on a remote machine's behalf rather than that machine's own coordinator. Gating per individual device-id is therefore the finest-grained, and only wire-protocol-honest, trust boundary actually implementable without a wire-mesh-core protocol change (deliberately out of scope here, matching agent-comms#156's own "gating the hub itself is out of scope" framing) -- confirmed as the intended granularity by hub-session.ts's own pre-existing isStateMutatingMessage doc comment, which already named this exact gap as "agent-comms#156's own future deliverable" of "per-peer" admission control. An operator who wants every local peer on a remote machine reachable trusts each of that machine's device-ids individually, not just its coordinator's.
 *
 * Principal-keyed trust (agent-comms#187): alongside the bare-device allowlist above, an operator may also trust a user-principal device-id (user-identity.ts) directly -- the root a remote peer's own dm:send-style delegation chain can terminate at, verified the same way device-membership-verification.ts already verifies a device's own group:member chain (`verifyCapabilityToken`'s chain-walk and its `rootIssuer` output). This is purely a second, parallel allowlist: `isTrusted`/`add`/`remove`/`list` keep checking only the bare-device set, unchanged, for a peer with no principal at all -- `isTrustedFor` is the additive entrypoint a caller who has already chain-verified a token uses to decide trust from that verified bearer and chain-root pair, accepting either a directly trusted device or a bearer rooted at a trusted principal. Persisted alongside the bare-device set (agent-comms#186's own persistence, extended here per that issue's own "agent-comms#187 covers what gets stored" framing): loadGatewayTrust/saveGatewayTrust now carry both sets.
 */
import type { IdentitySlot } from "./identity-store.js";
import { loadGatewayTrust, saveGatewayTrust } from "./identity-store.js";

/** The read-only slice of GatewayTrust every consumer of the trust boundary actually needs (WireMeshTransport, HubSession, hub-forwarding.ts) -- named so call sites that only ever read trust decisions, never mutate them, don't repeat the same `Pick<GatewayTrust, "isTrusted" | "hasAny" | "isTrustedPrincipal" | "isTrustedFor">` inline at every field/parameter that takes one. */
export type GatewayTrustReader = Pick<
  GatewayTrust,
  | "isTrusted"
  | "isReachable"
  | "hasAny"
  | "isTrustedPrincipal"
  | "isTrustedFor"
  | "listPrincipals"
  | "noteVerifiedMember"
>;

export class GatewayTrust {
  private readonly trusted = new Set<string>();
  private readonly trustedPrincipals = new Set<string>();
  /** Devices whose gossiped membership proof was verified against a trusted principal, with that principal and when the proof lapses. In memory only: a proof is short-lived and re-verified from the next advert, so nothing here is worth persisting. */
  private readonly verifiedMembers = new Map<
    string,
    { principal: string; expiresAt: number }
  >();
  private readonly slot: Readonly<IdentitySlot> | undefined;

  /** Constructs the trust boundary, optionally bound to a bridge identity slot for persistence (agent-comms#186); see this class's own doc comment for what a slot does and doesn't change. Given a slot, immediately loads whatever devices and principals were trusted before the last restart into the initial in-memory sets. */
  constructor(slot?: Readonly<IdentitySlot>) {
    this.slot = slot;
    if (slot !== undefined) {
      const loaded = loadGatewayTrust(slot);
      for (const deviceHex of loaded.devices) {
        this.trusted.add(deviceHex);
      }
      for (const principalHex of loaded.principals) {
        this.trustedPrincipals.add(principalHex);
      }
    }
  }

  /** Marks a remote device-id (hex, case-insensitive) as trusted: this side will merge its gossiped directory entries, dispatch its relayed requests, and route outbound hub requests to it. Idempotent. Persists the updated set when this instance was constructed with a slot. */
  add(deviceHex: string): void {
    this.trusted.add(deviceHex.toLowerCase());
    this.persist();
  }

  /** Withdraws a previously trusted device-id (hex, case-insensitive). A no-op if it was never trusted. Mirrors FederationManager.removeTrustedFingerprint's own precedent: already-merged directory entries and in-flight requests are unaffected -- this governs future traffic only. Persists the updated set when this instance was constructed with a slot. */
  remove(deviceHex: string): void {
    this.trusted.delete(deviceHex.toLowerCase());
    this.persist();
  }

  /** Writes the complete current trusted device and principal sets back to this instance's own slot, if it was constructed with one. A no-op for the in-memory-only (no slot) case. */
  private persist(): void {
    if (this.slot !== undefined) {
      saveGatewayTrust(this.slot, this.list(), this.listPrincipals());
    }
  }

  /** Every currently trusted device-id, lowercase hex, in insertion order. */
  list(): string[] {
    return [...this.trusted];
  }

  /** Whether the given device-id (hex, case-insensitive) is trusted by id: on the bare-device allowlist. A device trusted only because a principal vouches for it (noteVerifiedMember) is not, on purpose: its proof is a claim that anyone who has read the device's gossiped advert can repeat, so it earns only what isReachable grants. */
  isTrusted(deviceHex: string): boolean {
    return this.trusted.has(deviceHex.toLowerCase());
  }

  /** Whether this side may merge the device's gossiped directory entry and route requests to it: trusted by id, or a verified member of a trusted principal. Requests routed to a device are still authenticated end to end by the session inside the relay, so a false claim can misroute one (which then fails its handshake) but not read or forge one. */
  isReachable(deviceHex: string): boolean {
    const key = deviceHex.toLowerCase();
    return this.trusted.has(key) || this.isVerifiedMember(key);
  }

  /** Records that deviceHex presented a membership proof, valid until expiresAt (epoch ms), verified against principalHex (agent-comms#266). From then until the proof lapses, or principalHex stops being trusted, isReachable treats the device as reachable. A later proof never shortens an earlier one's window. The caller has already verified the proof: this class does no cryptography. */
  noteVerifiedMember(
    deviceHex: string,
    principalHex: string,
    expiresAt: number,
  ): void {
    const key = deviceHex.toLowerCase();
    const now = Date.now();
    for (const [device, member] of this.verifiedMembers) {
      if (member.expiresAt <= now) this.verifiedMembers.delete(device);
    }
    const existing = this.verifiedMembers.get(key);
    this.verifiedMembers.set(key, {
      principal: principalHex.toLowerCase(),
      expiresAt: Math.max(expiresAt, existing?.expiresAt ?? 0),
    });
  }

  /** Every device currently reachable only because a trusted principal vouches for it, with that principal. Excludes proofs that have lapsed and members whose principal is no longer trusted. */
  listVerifiedMembers(): { device: string; principal: string }[] {
    return [...this.verifiedMembers]
      .filter(([device]) => this.isVerifiedMember(device))
      .map(([device, member]) => ({ device, principal: member.principal }));
  }

  private isVerifiedMember(deviceKey: string): boolean {
    const member = this.verifiedMembers.get(deviceKey);
    return (
      member !== undefined &&
      member.expiresAt > Date.now() &&
      this.trustedPrincipals.has(member.principal)
    );
  }

  /** Marks a remote user-principal device-id (hex, case-insensitive; user-identity.ts) as trusted (agent-comms#187): a peer presenting a token whose delegation chain roots at this principal is trusted via `isTrustedFor` below, without that peer's own bare device-id ever needing individual trust. Idempotent, and entirely independent of the bare-device allowlist `add` manages. Persists the updated set when this instance was constructed with a slot. */
  addPrincipal(deviceHex: string): void {
    this.trustedPrincipals.add(deviceHex.toLowerCase());
    this.persist();
  }

  /** Withdraws a previously trusted principal (hex, case-insensitive). A no-op if it was never trusted. Governs future chain checks only, mirroring `remove`'s own already-merged-traffic-is-unaffected posture. Persists the updated set when this instance was constructed with a slot. */
  removePrincipal(deviceHex: string): void {
    const key = deviceHex.toLowerCase();
    this.trustedPrincipals.delete(key);
    for (const [device, member] of this.verifiedMembers) {
      if (member.principal === key) this.verifiedMembers.delete(device);
    }
    this.persist();
  }

  /** Every currently trusted principal device-id, lowercase hex, in insertion order. */
  listPrincipals(): string[] {
    return [...this.trustedPrincipals];
  }

  /** Whether the given device-id (hex, case-insensitive) is currently trusted as a user principal. */
  isTrustedPrincipal(deviceHex: string): boolean {
    return this.trustedPrincipals.has(deviceHex.toLowerCase());
  }

  /**
   * Whether a peer is trusted, given a token's own bearer and chain-root device-ids (hex, case-insensitive) a caller has already chain-verified via `verifyCapabilityToken` (the same `rootIssuer` output device-membership-verification.ts's own chain check already relies on). Passes when the bearer itself is directly trusted (the existing bare-device path, unmodified for a peer with no principal at all), OR when the chain's root is a trusted principal -- so a device sub-delegated from an admitted principal (mirroring agent-comms#161's own "principal admits its own devices" pattern) is trusted without ever being individually allowlisted. This class performs no cryptographic verification itself; the caller supplies already-verified device-ids, keeping GatewayTrust the same plain allowlist it always was.
   */
  isTrustedFor(bearerHex: string, rootIssuerHex: string): boolean {
    return this.isTrusted(bearerHex) || this.isTrustedPrincipal(rootIssuerHex);
  }

  /**
   * Whether at least one remote device or principal is currently trusted -- the outbound gossip gate. wire-mesh-core's relay-hub broadcasts a gossiped advert to every connected hub peer with no per-recipient targeting (RelayHub.handleConnection's own "re-broadcasts each gossip frame to every other connected client"), so "advertise local agents only to allowlisted remote gateways" can only be approximated at the coarse granularity this side actually controls: don't advertise anything at all until the operator has opted in by trusting at least one remote device or principal. Once true, an advertisement still reaches every hub-connected peer, trusted or not -- the per-device isTrusted()/isTrustedFor() checks above are what keep this side from ACTING on anything an untrusted peer sends back, which is the boundary that actually matters.
   */
  hasAny(): boolean {
    return this.trusted.size > 0 || this.trustedPrincipals.size > 0;
  }
}

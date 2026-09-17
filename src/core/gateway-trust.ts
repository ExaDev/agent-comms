/**
 * GatewayTrust -- the cross-machine trust boundary (agent-comms#156, agent-comms#153's third leg): an allowlist of remote device-ids this machine's gateway will advertise its local agents to, accept forwarded hub traffic from, and route outbound hub requests to. Deny-all by default: empty until an operator explicitly trusts at least one remote device, the same no-CA pin-the-key model ordinary peer connections already use.
 *
 * In-memory only, deliberately mirroring the precedent set by v1's own FederationManager.trustedFingerprints (retired with federation.ts, commit 4232b08) -- neither persists to disk, so trust is re-established each run rather than carried across restarts. This isn't a gap being deferred: v1 never persisted its own equivalent allowlist either, so no existing behaviour is being narrowed by keeping this one in memory too.
 *
 * Keyed by individual device-id, not by "one entry per remote machine": wire-mesh-core's relay-hub protocol (relay-hub.ts, gossip-frame, relay-data-frame) carries no field identifying which remote gateway connection a given directory entry or relayed request actually originated from -- only the entry/request's own device-id, which may be an ordinary local peer forwarded on a remote machine's behalf rather than that machine's own coordinator. Gating per individual device-id is therefore the finest-grained, and only wire-protocol-honest, trust boundary actually implementable without a wire-mesh-core protocol change (deliberately out of scope here, matching agent-comms#156's own "gating the hub itself is out of scope" framing) -- confirmed as the intended granularity by hub-session.ts's own pre-existing isStateMutatingMessage doc comment, which already named this exact gap as "agent-comms#156's own future deliverable" of "per-peer" admission control. An operator who wants every local peer on a remote machine reachable trusts each of that machine's device-ids individually, not just its coordinator's.
 */
/** The read-only slice of GatewayTrust every consumer of the trust boundary actually needs (WireMeshTransport, HubSession, hub-forwarding.ts) -- named so call sites that only ever read trust decisions, never mutate them, don't repeat the same `Pick<GatewayTrust, "isTrusted" | "hasAny">` inline at every field/parameter that takes one. */
export type GatewayTrustReader = Pick<GatewayTrust, "isTrusted" | "hasAny">;

export class GatewayTrust {
  private readonly trusted = new Set<string>();

  /** Marks a remote device-id (hex, case-insensitive) as trusted: this side will merge its gossiped directory entries, dispatch its relayed requests, and route outbound hub requests to it. Idempotent. */
  add(deviceHex: string): void {
    this.trusted.add(deviceHex.toLowerCase());
  }

  /** Withdraws a previously trusted device-id (hex, case-insensitive). A no-op if it was never trusted. Mirrors FederationManager.removeTrustedFingerprint's own precedent: already-merged directory entries and in-flight requests are unaffected -- this governs future traffic only. */
  remove(deviceHex: string): void {
    this.trusted.delete(deviceHex.toLowerCase());
  }

  /** Every currently trusted device-id, lowercase hex, in insertion order. */
  list(): string[] {
    return [...this.trusted];
  }

  /** Whether the given device-id (hex, case-insensitive) is currently trusted. */
  isTrusted(deviceHex: string): boolean {
    return this.trusted.has(deviceHex.toLowerCase());
  }

  /**
   * Whether at least one remote device is currently trusted -- the outbound gossip gate. wire-mesh-core's relay-hub broadcasts a gossiped advert to every connected hub peer with no per-recipient targeting (RelayHub.handleConnection's own "re-broadcasts each gossip frame to every other connected client"), so "advertise local agents only to allowlisted remote gateways" can only be approximated at the coarse granularity this side actually controls: don't advertise anything at all until the operator has opted in by trusting at least one remote device. Once true, an advertisement still reaches every hub-connected peer, trusted or not -- the per-device isTrusted() check above is what keeps this side from ACTING on anything an untrusted peer sends back, which is the boundary that actually matters.
   */
  hasAny(): boolean {
    return this.trusted.size > 0;
  }
}

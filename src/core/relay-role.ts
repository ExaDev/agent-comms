/**
 * RelayRole: one transport's part in the relay set (agent-comms#342), split out of wire-mesh-transport.ts to keep it under the repo's max-lines cap. It holds the store's one hub session over the relay selection prefers (relay-selection.ts), and serves the relay role itself while it is eligible and holds an upstream session.
 *
 * Who serves: the store holding the elected coordinator role (agent-comms#341), and only while its hub session is to the configured public hub, its uplink. Tying serving to that single-holder role is what keeps one relay per machine: if every store holding an upstream session served, each would see the others' offers, move its own session onto one of them, lose its uplink, stop serving, and fall back to the public hub, over and over. For the same reason an eligible store always holds its session to the public hub and never selects another relay, so relays never chain.
 */

import type { PeerAdvert } from "wire-mesh-core/generated/protocol";
import { readRelayOffer } from "wire-mesh-core/domain/relay-advert";
import { HubLink } from "./hub-link.js";
import type { HubSession } from "./hub-session.js";
import type { ElectionSessions } from "./election-sessions.js";
import type { GatewayTrustReader } from "./gateway-trust.js";
import type { TransportEvents } from "./transport.js";
import { RelayServer } from "./relay-server.js";
import { selectRelay, type RelayOffer } from "./relay-selection.js";

export interface RelayRoleDeps {
  /** The interface a served relay listens on (RelayServerOptions.host). */
  listenHost: string;
  /** This store's own device-id (hex). */
  ownDeviceHex: string;
  /** Every device this store has heard gossip from, with its latest advert: where relay offers are read from. */
  knownDevices: ReadonlyMap<string, Readonly<PeerAdvert>>;
  /** The live machine-local sessions: a device with one is a full member of this store's local mesh. */
  machineLocalPeers: Readonly<Pick<ElectionSessions, "hasPeer">>;
  /** Gateway trust, whose reachability check admits a device learned through a hub. */
  gatewayTrust: Readonly<Pick<GatewayTrustReader, "isReachable">>;
  /** Re-sends this store's gossip, so the relay offer it carries changes at once and a new hub session is advertised straight away. */
  readvertise: () => void;
  events: Readonly<Pick<TransportEvents, "onError">>;
}

export class RelayRole {
  private eligible = false;
  private upstream = false;
  private server: RelayServer | undefined;
  /** Serialises start and stop, so a quick eligible/ineligible flip cannot leave two servers, or none where one should exist. */
  private transition: Promise<void> = Promise.resolve();
  /** Holds this store's one hub session over the selected relay, once joinHub has named the configured hub. */
  private hubLink: HubLink | undefined;

  constructor(private readonly deps: Readonly<RelayRoleDeps>) {}

  /** Starts holding the hub session: over the relay selection prefers, with publicHubUrl (the configured hub) as the fallback and as the uplink an eligible store serves from. A second call does nothing. */
  joinHub(
    hub: HubSession,
    publicHubUrl: string,
    shouldConnect: () => boolean,
  ): void {
    if (this.hubLink !== undefined) return;
    this.hubLink = new HubLink({
      hub,
      selectUrl: (excluded) => this.selectUrl(publicHubUrl, excluded),
      shouldConnect,
      onConnected: (url) => {
        this.setUpstream(url === publicHubUrl);
        this.deps.readvertise();
      },
      onDisconnected: () => {
        this.setUpstream(false);
      },
      onError: (error) => {
        this.deps.events.onError?.(error);
      },
    });
    this.hubLink.start();
  }

  /** Makes the hub session re-evaluate now whether it is wanted, and over which relay. */
  reconsiderHub(): void {
    this.hubLink?.reconsider();
  }

  /** The addresses this store currently offers relay service at, or undefined while it serves none. */
  offer(): readonly string[] | undefined {
    return this.server?.addresses();
  }

  /** How many clients the served relay has, or 0 while none is served. */
  servedConnectionCount(): number {
    return this.server === undefined ? 0 : this.server.connectionCount();
  }

  /** Whether this store may serve: set from the elected coordinator role. An eligible store moves its hub session back onto the uplink at once. */
  setEligible(eligible: boolean): void {
    this.eligible = eligible;
    this.reconcile();
    this.hubLink?.reconsider();
  }

  /** The URL to hold the hub session over: the public hub for an eligible store (its uplink), otherwise the best relay the policy finds, skipping any offer with an address in excluded (dials that just failed). */
  selectUrl(publicHubUrl: string, excluded: ReadonlySet<string>): string {
    if (this.eligible) return publicHubUrl;
    return selectRelay({
      offers: this.offers().filter((offer) =>
        offer.addresses.every((address) => !excluded.has(address)),
      ),
      isTrusted: (deviceHex) => this.deps.gatewayTrust.isReachable(deviceHex),
      ownDeviceHex: this.deps.ownDeviceHex,
      publicHubUrl,
    }).url;
  }

  /** Drops the hub session and stops serving, for good. */
  async stop(): Promise<void> {
    await this.hubLink?.stop();
    this.eligible = false;
    this.reconcile();
    await this.transition;
  }

  /** Whether this store's hub session is currently held to the configured public hub. */
  private setUpstream(upstream: boolean): void {
    this.upstream = upstream;
    this.reconcile();
  }

  private offers(): RelayOffer[] {
    const offers: RelayOffer[] = [];
    for (const [deviceHex, advert] of this.deps.knownDevices) {
      const addresses = readRelayOffer(advert);
      if (addresses === undefined) continue;
      offers.push({
        deviceHex,
        addresses,
        machineLocal: this.deps.machineLocalPeers.hasPeer(deviceHex),
      });
    }
    return offers;
  }

  private reconcile(): void {
    this.transition = this.transition
      .then(async () => {
        const wanted = this.eligible && this.upstream;
        if (wanted && this.server === undefined) {
          const server = new RelayServer({
            host: this.deps.listenHost,
            isAdmitted: (deviceHex) =>
              this.deps.machineLocalPeers.hasPeer(deviceHex) ||
              this.deps.gatewayTrust.isReachable(deviceHex),
          });
          await server.start();
          this.server = server;
          this.deps.readvertise();
        } else if (!wanted && this.server !== undefined) {
          const server = this.server;
          this.server = undefined;
          this.deps.readvertise();
          await server.stop();
        }
      })
      .catch((error: unknown) => {
        this.deps.events.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
  }
}

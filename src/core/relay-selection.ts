/**
 * Relay selection (agent-comms#342): which relay a store's one hub session is held over. The hub is a set rather than a single URL: every relay offer this store has heard (wire-mesh-core's relay-offer gossip extension) plus the configured public hub, ranked by a fixed policy.
 *
 * A direct connection always comes first, and needs nothing here: MeshTransport.sendRoomRequest reaches a device over its direct session whenever one exists and only falls back to the hub session for a device it has no session with. Among relays the order is: a relay served on this machine (offered by a peer this store holds a machine-local session with), then a relay on the local network (a trusted device offering a private or link-local address), then any trusted relay-offering device, then the configured public hub as the fallback.
 *
 * Trust stays deny-by-default: an offer from a device reached only through a hub is considered only when gateway trust admits that device (by id, or through a principal it proves membership of), exactly the check that already decides whether a hub-learned device is reachable at all. A machine-local peer's offer needs no separate trust decision, since that peer is already a full member of this store's local mesh. Relay payloads stay end-to-end encrypted between the two devices using it, so trusting a relay is a decision about availability and metadata, never content. A relay forwards between its own directly connected clients, one hop; nothing here routes through a chain of relays.
 */

import { BlockList, isIPv4, isIPv6 } from "node:net";

/** A relay offer this store has heard, with what it knows about the device making it. */
export interface RelayOffer {
  deviceHex: string;
  /** The ws:// or wss:// URLs the device offers relay service at. */
  addresses: readonly string[];
  /** Whether this store holds a machine-local session with the offering device. */
  machineLocal: boolean;
}

/** Which tier of the policy a selected relay came from, most preferred first. */
export type RelayTier = "machine" | "lan" | "trusted" | "public";

export interface SelectedRelay {
  url: string;
  tier: RelayTier;
  /** The offering device, absent for the configured public hub. */
  deviceHex?: string;
}

export interface RelaySelectionInput {
  offers: readonly RelayOffer[];
  /** Gateway trust's reachability check for a device learned only through a hub. */
  isTrusted: (deviceHex: string) => boolean;
  /** This store's own device-id: it never relays through its own offer. */
  ownDeviceHex: string;
  /** The configured public hub, the fallback when no offer qualifies. */
  publicHubUrl: string;
}

/** The private (RFC 1918), IPv4 link-local (RFC 3927), IPv6 unique-local (RFC 4193) and IPv6 link-local ranges: addresses reachable on the local network and nowhere else. */
const LOCAL_NETWORK_RANGES = new BlockList();
LOCAL_NETWORK_RANGES.addRange("10.0.0.0", "10.255.255.255", "ipv4");
LOCAL_NETWORK_RANGES.addRange("172.16.0.0", "172.31.255.255", "ipv4");
LOCAL_NETWORK_RANGES.addRange("192.168.0.0", "192.168.255.255", "ipv4");
LOCAL_NETWORK_RANGES.addRange("169.254.0.0", "169.254.255.255", "ipv4");
LOCAL_NETWORK_RANGES.addRange(
  "fc00::",
  "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
  "ipv6",
);
LOCAL_NETWORK_RANGES.addRange(
  "fe80::",
  "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
  "ipv6",
);

/** Whether a host names a loopback address, which only reaches a relay on this machine. */
function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

/** Whether a host literal is a private or link-local address: reachable on the local network and nowhere else. A host name is neither, since what it resolves to is not known here. */
function isPrivateHost(host: string): boolean {
  if (isIPv4(host)) return LOCAL_NETWORK_RANGES.check(host, "ipv4");
  if (isIPv6(host)) return LOCAL_NETWORK_RANGES.check(host, "ipv6");
  return false;
}

/** The host a relay URL names, or undefined for an address that is not a ws:// or wss:// URL (which is never dialled). */
function relayHost(address: string): string | undefined {
  if (!/^wss?:\/\//.test(address)) return undefined;
  try {
    // URL keeps an IPv6 literal's brackets in hostname; strip them so isIP recognises it.
    return new URL(address).hostname.replace(/^\[(.*)\]$/, "$1");
  } catch {
    return undefined;
  }
}

/** The best address an offer has for a tier, or undefined when it has none that tier accepts. */
function addressFor(
  offer: Readonly<RelayOffer>,
  tier: RelayTier,
): string | undefined {
  for (const address of offer.addresses) {
    const host = relayHost(address);
    if (host === undefined) continue;
    if (tier === "machine" && isLoopbackHost(host)) return address;
    if (tier === "lan" && isPrivateHost(host)) return address;
    if (tier === "trusted" && !isLoopbackHost(host)) return address;
  }
  return undefined;
}

const OFFER_TIERS: readonly Exclude<RelayTier, "public">[] = [
  "machine",
  "lan",
  "trusted",
];

/** Picks the relay to hold this store's hub session over. Within a tier the lowest device-id wins, so every store that hears the same offers makes the same choice. */
export function selectRelay(
  input: Readonly<RelaySelectionInput>,
): SelectedRelay {
  const eligible = input.offers
    .filter((offer) => offer.deviceHex !== input.ownDeviceHex)
    .toSorted((a, b) => a.deviceHex.localeCompare(b.deviceHex));
  for (const tier of OFFER_TIERS) {
    for (const offer of eligible) {
      const admitted =
        tier === "machine"
          ? offer.machineLocal
          : input.isTrusted(offer.deviceHex);
      if (!admitted) continue;
      const url = addressFor(offer, tier);
      if (url !== undefined) return { url, tier, deviceHex: offer.deviceHex };
    }
  }
  return { url: input.publicHubUrl, tier: "public" };
}

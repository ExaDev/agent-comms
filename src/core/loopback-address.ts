/**
 * Whether an address this side dials can only reach this machine, judged from the address literal alone. WireMeshTransport uses it to decide whether a dialled session takes part in the coordinator election (agent-comms#341): the dialler knows nothing about the far side's listener beyond the address it dialled, and a peer list or a first-contact beacon heard over LAN broadcast can name any host.
 */

import * as net from "node:net";

/** RFC 1122 section 3.2.1.3 reserves the whole of 127.0.0.0/8 for loopback, not just 127.0.0.1. */
const IPV4_LOOPBACK_NETWORK = "127.0.0.0";
const IPV4_LOOPBACK_PREFIX_LENGTH = 8;
/** RFC 4291 section 2.5.3: IPv6 has a single loopback address. */
const IPV6_LOOPBACK_ADDRESS = "::1";

const LOOPBACK = new net.BlockList();
LOOPBACK.addSubnet(IPV4_LOOPBACK_NETWORK, IPV4_LOOPBACK_PREFIX_LENGTH, "ipv4");
LOOPBACK.addAddress(IPV6_LOOPBACK_ADDRESS, "ipv6");

/** True for an IPv4 address in 127.0.0.0/8, the IPv6 loopback address, or an IPv4-mapped IPv6 form of the former. False for every other address and for any hostname, since a name may resolve anywhere and is never evidence of where the far side is. */
export function isLoopbackAddress(host: string): boolean {
  if (net.isIPv4(host)) return LOOPBACK.check(host, "ipv4");
  if (net.isIPv6(host)) return LOOPBACK.check(host, "ipv6");
  return false;
}

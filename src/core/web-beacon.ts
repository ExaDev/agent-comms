/**
 * The LAN web UI beacon's own type and payload (agent-comms#346, receiving side agent-comms#353): the one datagram shape both the sender (bridges/user/web/web-beacon.ts) and every listener on the first-contact port agree on, kept in core so first-contact can recognise it without depending on a bridge.
 */

/** The beacon type, distinct from first-contact's own `agent-comms-beacon`. */
export const WEB_BEACON_TYPE = "agent-comms-web-beacon";

/** What a beacon carries: the broadcasting bridge's peer id and the port its web UI listens on, and nothing else. The receiver learns the host from the datagram's source address, and the access token is never advertised, so seeing the beacon grants no access. */
export interface WebBeaconPayload {
  type: typeof WEB_BEACON_TYPE;
  peerId: string;
  webPort: number;
}

/** The exclusive upper bound of the UDP port space: a port is a 16-bit integer. */
const MAX_UDP_PORT = 0x10000;

/** Narrows an untrusted datagram body into a WebBeaconPayload. */
export function isWebBeaconPayload(
  value: unknown,
): value is Readonly<WebBeaconPayload> {
  if (typeof value !== "object" || value === null) return false;
  if (!("type" in value) || value.type !== WEB_BEACON_TYPE) return false;
  if (!("peerId" in value) || typeof value.peerId !== "string") return false;
  if (!("webPort" in value) || typeof value.webPort !== "number") return false;
  return (
    Number.isInteger(value.webPort) &&
    value.webPort > 0 &&
    value.webPort < MAX_UDP_PORT
  );
}

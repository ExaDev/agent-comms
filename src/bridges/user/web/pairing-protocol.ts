/**
 * What the hosted dashboard and the bridge agree on for pairing (web-pairing.ts describes the design): the names of the fragment parameter, the WebSocket subprotocols and the request header, and the shape of a secret. Shared by the Node server and the browser frontend, so it imports nothing from either.
 */

/** The name of the fragment parameter the pairing page opens the dashboard with. */
export const PAIRING_FRAGMENT_PARAM = "pair";

/** The request header that carries the secret on an HTTP request. */
export const PAIRING_HEADER = "x-agent-comms-pairing";

/** The prefix of the WebSocket subprotocol that carries the secret on an upgrade. */
export const PAIRING_SUBPROTOCOL_PREFIX = "agent-comms-pairing.";

/** The subprotocol a server selects for every upgrade that offers the dashboard's protocols, so the offered secret is never echoed back. */
export const MESH_SUBPROTOCOL = "agent-comms";

/** What a secret looks like: exactly 32 bytes in lower-case hex. */
export const PAIRING_SECRET_PATTERN = /^[0-9a-f]{64}$/;

/** The subprotocols the dashboard offers when it opens a mesh socket: the fixed one, and the one carrying its secret when it has one. */
export function meshSocketProtocols(
  pairingSecret: string | undefined,
): string[] {
  return pairingSecret === undefined
    ? [MESH_SUBPROTOCOL]
    : [MESH_SUBPROTOCOL, `${PAIRING_SUBPROTOCOL_PREFIX}${pairingSecret}`];
}

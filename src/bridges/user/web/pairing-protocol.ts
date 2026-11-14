/**
 * What the hosted dashboard and the bridge agree on for pairing (web-pairing.ts describes the design): the fragment parameter the pairing page hands the secret over in, the paths and subprotocols of the proof exchange, the shape of its messages, and the bytes each side keys its proof over. Shared by the Node server and the browser frontend, so it imports nothing from either.
 *
 * The secret never crosses a socket. Before the dashboard sends anything to a listener it asks the listener to prove it holds the secret, and only then proves it holds it too (see `proofInput`); the bridge answers with a single-use ticket that admits one mesh socket.
 */

/** The name of the fragment parameter the pairing page opens the dashboard with. */
export const PAIRING_FRAGMENT_PARAM = "pair";

/** The path of the mesh socket the dashboard's own traffic runs over. */
export const MESH_PATH = "/ws/mesh";

/** The path of the socket the proof exchange runs over. It carries nothing but the exchange, and a page of the hosted origin may open it without a ticket. */
export const HELLO_PATH = "/ws/hello";

/** The subprotocol a server selects for every mesh upgrade that offers the dashboard's protocols, so the offered ticket is never echoed back. */
export const MESH_SUBPROTOCOL = "agent-comms";

/** The prefix of the subprotocol that carries a ticket on a mesh upgrade, because the browser's WebSocket API cannot set headers and a query string would put the ticket in logs and history. */
export const TICKET_SUBPROTOCOL_PREFIX = "agent-comms-ticket.";

/** What a secret looks like: exactly 32 bytes in lower-case hex. */
export const PAIRING_SECRET_PATTERN = /^[0-9a-f]{64}$/;

/** What a nonce, a proof and a ticket look like: 32 bytes in lower-case hex. */
export const HEX_32_PATTERN = /^[0-9a-f]{64}$/;

/** Random bytes in a nonce, and in a ticket. */
export const NONCE_BYTES = 32;

/** The role label a proof is keyed over: the bridge proving it holds the secret, and the dashboard proving it. Different labels and a different order of the two nonces keep one proof from standing in for the other. */
export type ProofRole = "bridge" | "client";

/** The dashboard's first message: its fresh nonce. */
export interface HelloRequest {
  type: "hello";
  nonce: string;
}

/** The bridge's answer: its own fresh nonce and its proof over both. */
export interface HelloReply {
  type: "hello-ok";
  nonce: string;
  proof: string;
}

/** The dashboard's proof, sent only after the bridge's checked out. */
export interface HelloAuth {
  type: "auth";
  proof: string;
}

/** The bridge's last message: the single-use ticket for one mesh socket. */
export interface HelloTicket {
  type: "ticket";
  ticket: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hex32(value: unknown): value is string {
  return typeof value === "string" && HEX_32_PATTERN.test(value);
}

/** Reads one JSON message of the exchange, or undefined for text that is not JSON. The caller narrows the result with the guards below. */
export function parseHelloMessage(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function isHelloRequest(value: unknown): value is HelloRequest {
  return isRecord(value) && value.type === "hello" && hex32(value.nonce);
}

export function isHelloReply(value: unknown): value is HelloReply {
  return (
    isRecord(value) &&
    value.type === "hello-ok" &&
    hex32(value.nonce) &&
    hex32(value.proof)
  );
}

export function isHelloAuth(value: unknown): value is HelloAuth {
  return isRecord(value) && value.type === "auth" && hex32(value.proof);
}

export function isHelloTicket(value: unknown): value is HelloTicket {
  return isRecord(value) && value.type === "ticket" && hex32(value.ticket);
}

/** What a proof is made over: whose proof it is, the two nonces in the order the exchange sent them (the dashboard's, then the bridge's) and the port the dashboard dialled. */
export interface ProofTranscript {
  role: ProofRole;
  clientNonce: string;
  bridgeNonce: string;
  port: number;
}

/**
 * The bytes a proof is keyed over, with the secret as the key. A proof for one port is not one for another, so a listener that relays the dashboard's challenge to the real bridge on a different port cannot pass the answer off as its own.
 */
export function proofInput(
  transcript: Readonly<ProofTranscript>,
): Uint8Array<ArrayBuffer> {
  const { role, clientNonce, bridgeNonce, port } = transcript;
  return new TextEncoder().encode(
    [role, clientNonce, bridgeNonce, String(port)].join("\0"),
  );
}

/** The subprotocols the dashboard offers when it opens a mesh socket: the fixed one, and the one carrying its ticket when it has one. */
export function meshSocketProtocols(ticket: string | undefined): string[] {
  return ticket === undefined
    ? [MESH_SUBPROTOCOL]
    : [MESH_SUBPROTOCOL, `${TICKET_SUBPROTOCOL_PREFIX}${ticket}`];
}

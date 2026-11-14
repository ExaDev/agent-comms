/**
 * The bridge's half of the proof exchange that admits the hosted dashboard (web-pairing.ts describes the design): the keyed proof, the single-use tickets a completed exchange issues, and the handler of one `/ws/hello` socket.
 *
 * A listener that does not hold the secret is told nothing and given nothing by this module beyond a nonce: the bridge's proof is keyed with the secret, and the dashboard's proof is checked before any ticket is issued.
 */

import * as crypto from "node:crypto";
import {
  NONCE_BYTES,
  isHelloAuth,
  isHelloRequest,
  parseHelloMessage,
  proofInput,
  type HelloReply,
  type HelloTicket,
  type ProofTranscript,
} from "./pairing-protocol.js";
import type { PairingSecretStore } from "./web-pairing.js";

/** How long a ticket admits a mesh socket after it is issued. The dashboard opens the socket at once, so a few seconds is far above the real delay and keeps an unused ticket from being worth holding. */
export const TICKET_LIFETIME_MS = 10_000;

/** The most tickets that wait to be used at once: a bridge has one dashboard, so a few is generous, and a client that asks for more is refused rather than served. */
export const MAX_PENDING_TICKETS = 16;

/** How long one exchange may take from its first byte to the ticket, which is a few small frames over loopback. */
export const HELLO_TIMEOUT_MS = 5000;

/** The most exchanges in progress at once. */
export const MAX_HELLO_SOCKETS = 16;

/** The largest message of the exchange: a JSON object of at most two 64-character hex values. */
export const MAX_HELLO_MESSAGE_BYTES = 1024;

/** WebSocket close code for a message that breaks the endpoint's policy, used for every refusal so none says which check failed. */
const CLOSE_POLICY_VIOLATION = 1008;
const CLOSE_NORMAL = 1000;

/** The proof a party holding `secret` gives over this exchange, as hex. */
export function computeProof(
  secret: string,
  transcript: Readonly<ProofTranscript>,
): string {
  return crypto
    .createHmac("sha256", Buffer.from(secret, "hex"))
    .update(proofInput(transcript))
    .digest("hex");
}

/** Whether `presented` is the proof for this exchange under `secret`, compared in constant time. */
export function proofMatches(
  presented: string,
  secret: string,
  transcript: Readonly<ProofTranscript>,
): boolean {
  const expected = Buffer.from(computeProof(secret, transcript), "hex");
  const given = Buffer.from(presented, "hex");
  return (
    given.length === expected.length && crypto.timingSafeEqual(given, expected)
  );
}

/** The single-use tickets a completed exchange issues. */
export interface TicketBook {
  /** A fresh ticket, or undefined when too many wait to be used. */
  issue: () => string | undefined;
  /** Whether `presented` is a ticket that was issued, has not been used or expired, and was issued under the secret still in force. Spends it either way: a ticket is offered once. */
  consume: (presented: string | undefined) => boolean;
}

/** A ticket book over a secret store: a ticket issued under a secret that has since been replaced is never accepted. */
export function createTicketBook(
  secret: Readonly<PairingSecretStore>,
  now: () => number = Date.now,
): TicketBook {
  const pending = new Map<string, { expires: number; generation: number }>();
  const prune = (): void => {
    const current = now();
    for (const [ticket, entry] of pending) {
      if (entry.expires <= current) pending.delete(ticket);
    }
  };
  return {
    issue: () => {
      prune();
      if (pending.size >= MAX_PENDING_TICKETS) return undefined;
      secret.current();
      const ticket = crypto.randomBytes(NONCE_BYTES).toString("hex");
      pending.set(ticket, {
        expires: now() + TICKET_LIFETIME_MS,
        generation: secret.generation(),
      });
      return ticket;
    },
    consume: (presented) => {
      if (presented === undefined) return false;
      prune();
      const entry = pending.get(presented);
      if (entry === undefined) return false;
      pending.delete(presented);
      secret.current();
      return entry.generation === secret.generation();
    },
  };
}

/** What serving a hello socket needs. */
export interface HelloOptions {
  secret: Readonly<PairingSecretStore>;
  tickets: Readonly<TicketBook>;
  /** The port the server listens on, which both proofs are keyed over. */
  port: () => number;
  /** The timer in force for the exchange; tests replace it. */
  timeoutMs?: number;
}

/** The text of one WebSocket message as `ws` hands it over. */
function textOf(data: Buffer | ArrayBuffer | readonly Buffer[]): string {
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString();
  if (Buffer.isBuffer(data)) return data.toString();
  return Buffer.concat([...data]).toString();
}

function newNonce(): string {
  return crypto.randomBytes(NONCE_BYTES).toString("hex");
}

/** The parts of a `ws` socket the exchange uses, so a test can stand in for one. */
export interface HelloSocket {
  on: ((
    event: "message",
    listener: (
      data: Buffer | ArrayBuffer | readonly Buffer[],
      isBinary: boolean,
    ) => void,
  ) => unknown) &
    ((event: "close" | "error", listener: () => void) => unknown);
  send: (data: string, callback?: () => void) => void;
  close: (code?: number) => void;
  terminate: () => void;
}

/**
 * Runs the bridge's half of the exchange on one `/ws/hello` socket: answers the dashboard's nonce with the bridge's own and a proof, checks the dashboard's proof, and on success sends one ticket and closes. Any other message, a message of the wrong form, a wrong proof, a secret that was replaced meanwhile or silence past the timeout closes the socket with the same status and no explanation.
 */
export function serveHello(
  socket: Readonly<HelloSocket>,
  options: Readonly<HelloOptions>,
): void {
  let stage: "hello" | "auth" | "done" = "hello";
  let exchange:
    | {
        secret: string;
        clientNonce: string;
        bridgeNonce: string;
        generation: number;
      }
    | undefined;

  const timer: { handle?: NodeJS.Timeout } = {};
  const refuse = (): void => {
    stage = "done";
    clearTimeout(timer.handle);
    socket.close(CLOSE_POLICY_VIOLATION);
  };
  timer.handle = setTimeout(refuse, options.timeoutMs ?? HELLO_TIMEOUT_MS);
  timer.handle.unref();
  socket.on("close", () => {
    stage = "done";
    clearTimeout(timer.handle);
  });
  // A socket error is that connection's alone; the close that follows ends the exchange.
  socket.on("error", () => {
    socket.terminate();
  });

  socket.on("message", (data, isBinary) => {
    if (isBinary || stage === "done") {
      refuse();
      return;
    }
    const message = parseHelloMessage(textOf(data));
    if (stage === "hello") {
      if (!isHelloRequest(message)) {
        refuse();
        return;
      }
      const secret = options.secret.current();
      const bridgeNonce = newNonce();
      const port = options.port();
      exchange = {
        secret,
        clientNonce: message.nonce,
        bridgeNonce,
        generation: options.secret.generation(),
      };
      const reply: HelloReply = {
        type: "hello-ok",
        nonce: bridgeNonce,
        proof: computeProof(secret, {
          role: "bridge",
          clientNonce: message.nonce,
          bridgeNonce,
          port,
        }),
      };
      stage = "auth";
      socket.send(JSON.stringify(reply));
      return;
    }
    if (!isHelloAuth(message) || exchange === undefined) {
      refuse();
      return;
    }
    const { secret, clientNonce, bridgeNonce, generation } = exchange;
    const proven = proofMatches(message.proof, secret, {
      role: "client",
      clientNonce,
      bridgeNonce,
      port: options.port(),
    });
    options.secret.current();
    if (!proven || options.secret.generation() !== generation) {
      refuse();
      return;
    }
    const ticket = options.tickets.issue();
    if (ticket === undefined) {
      refuse();
      return;
    }
    stage = "done";
    clearTimeout(timer.handle);
    const reply: HelloTicket = { type: "ticket", ticket };
    socket.send(JSON.stringify(reply), () => {
      socket.close(CLOSE_NORMAL);
    });
  });
}

/** How often the server looks for sockets admitted under a secret that has been replaced. */
export const ROTATION_SWEEP_MS = 1000;

/** WebSocket close code a socket gets when the secret it was admitted under is gone. */
const CLOSE_REVOKED = 1008;

/** The parts of a `ws` socket the guard uses. */
export interface AdmittedSocket {
  close: (code?: number) => void;
  on: (event: "close", listener: () => void) => unknown;
}

/** Tracks the mesh sockets admitted to the hosted dashboard, so that replacing the secret ends them. */
export interface HostedSocketGuard {
  /** Starts tracking a socket admitted under the secret now in force, and ends it when that secret is replaced. */
  track: (socket: Readonly<AdmittedSocket>) => void;
  /** Whether the socket is still admitted; closes it and answers false when its secret has been replaced. */
  check: (socket: Readonly<AdmittedSocket>) => boolean;
  /** Closes every tracked socket whose secret has been replaced. Run on a timer, so an idle socket ends too. */
  sweep: () => void;
}

export function createHostedSocketGuard(
  secret: Readonly<PairingSecretStore>,
): HostedSocketGuard {
  const admitted = new Map<AdmittedSocket, number>();
  const revoked = (generation: number): boolean => {
    secret.current();
    return secret.generation() !== generation;
  };
  const check = (socket: Readonly<AdmittedSocket>): boolean => {
    const generation = admitted.get(socket);
    if (generation === undefined) return true;
    if (!revoked(generation)) return true;
    admitted.delete(socket);
    socket.close(CLOSE_REVOKED);
    return false;
  };
  return {
    track: (socket) => {
      secret.current();
      admitted.set(socket, secret.generation());
      socket.on("close", () => {
        admitted.delete(socket);
      });
    },
    check,
    sweep: () => {
      for (const socket of [...admitted.keys()]) check(socket);
    },
  };
}

/**
 * The dashboard's half of the proof exchange with a bridge (see web-pairing.ts for the design), run in the browser and using only the `WebSocket` and Web Crypto globals the browser and Node both have, so it imports nothing from either: before the dashboard sends a listener anything, it asks it to prove it holds the secret this browser was paired with, checks that proof, and only then proves it holds the secret too. The secret is the key of both proofs and is never sent.
 */

import {
  HELLO_PATH,
  HEX_32_PATTERN,
  NONCE_BYTES,
  isHelloReply,
  isHelloTicket,
  parseHelloMessage,
  proofInput,
  type HelloAuth,
  type HelloRequest,
  type ProofTranscript,
} from "./pairing-protocol.js";

/** How long the whole exchange may take before the port counts as no bridge. A bridge answers three small frames on loopback well inside this. */
export const HANDSHAKE_TIMEOUT_MS = 2000;

const HEX_RADIX = 16;
const HEX_DIGITS_PER_BYTE = 2;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) =>
    byte.toString(HEX_RADIX).padStart(HEX_DIGITS_PER_BYTE, "0"),
  ).join("");
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / HEX_DIGITS_PER_BYTE);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(
      hex.slice(index * HEX_DIGITS_PER_BYTE, (index + 1) * HEX_DIGITS_PER_BYTE),
      HEX_RADIX,
    );
  }
  return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    fromHex(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** The proof a holder of `secret` gives for this exchange, as hex. */
export async function proofFor(
  secret: string,
  transcript: Readonly<ProofTranscript>,
): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    proofInput(transcript),
  );
  return toHex(new Uint8Array(signature));
}

/** Whether `presented` is the proof for this exchange under `secret`. The comparison is the platform's own `verify`, which is constant time. */
export async function proofChecks(
  presented: string,
  secret: string,
  transcript: Readonly<ProofTranscript>,
): Promise<boolean> {
  if (!HEX_32_PATTERN.test(presented)) return false;
  return crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    fromHex(presented),
    proofInput(transcript),
  );
}

/** The address of the exchange's socket on `port`. */
export function helloUrl(port: number): string {
  return `ws://127.0.0.1:${String(port)}${HELLO_PATH}`;
}

function newNonce(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

/**
 * Runs the exchange with whatever listens on `port` and resolves with the single-use ticket for one mesh socket, or undefined when the listener is not a bridge that holds `secret`, or does not answer in time. What the listener is sent before it has proved itself is one nonce.
 */
export async function acquireTicket(
  port: number,
  secret: string,
  timeoutMs: number = HANDSHAKE_TIMEOUT_MS,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(helloUrl(port));
    } catch {
      resolve(undefined);
      return;
    }
    const clientNonce = newNonce();
    let bridgeNonce: string | undefined;
    let settled = false;
    const timer: { handle?: ReturnType<typeof setTimeout> } = {};
    const settle = (ticket: string | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer.handle);
      socket.close();
      resolve(ticket);
    };
    timer.handle = setTimeout(() => {
      settle(undefined);
    }, timeoutMs);
    socket.addEventListener("error", () => {
      settle(undefined);
    });
    socket.addEventListener("close", () => {
      settle(undefined);
    });
    socket.addEventListener("open", () => {
      const request: HelloRequest = { type: "hello", nonce: clientNonce };
      socket.send(JSON.stringify(request));
    });
    socket.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data !== "string") {
        settle(undefined);
        return;
      }
      const message = parseHelloMessage(event.data);
      if (bridgeNonce === undefined) {
        if (!isHelloReply(message)) {
          settle(undefined);
          return;
        }
        bridgeNonce = message.nonce;
        void proofChecks(message.proof, secret, {
          role: "bridge",
          clientNonce,
          bridgeNonce: message.nonce,
          port,
        })
          .then(async (genuine) => {
            if (!genuine) {
              settle(undefined);
              return;
            }
            const auth: HelloAuth = {
              type: "auth",
              proof: await proofFor(secret, {
                role: "client",
                clientNonce,
                bridgeNonce: message.nonce,
                port,
              }),
            };
            socket.send(JSON.stringify(auth));
          })
          .catch(() => {
            settle(undefined);
          });
        return;
      }
      settle(isHelloTicket(message) ? message.ticket : undefined);
    });
  });
}

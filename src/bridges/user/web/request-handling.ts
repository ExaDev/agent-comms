/**
 * How the web bridge reads a request body and answers a route whose work fails: every body has a maximum size, every failure of a route's asynchronous work becomes a response, and nothing a client sends can end the process.
 */

import type * as http from "node:http";
import { MAX_MESSAGE_BYTES } from "../../../core/message-limits.js";
import { CommsError } from "../../../core/store.js";

const HTTP_BAD_REQUEST = 400;
const BYTES_PER_KIB = 1024;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_INTERNAL_SERVER_ERROR = 500;

const MS_PER_SECOND = 1000;
/** The slowest rate at which a client is still given time to send a body: 32 KiB a second, about a hundredth of a modest uplink, so a slow but moving client is served and one that sends a few bytes and stops is not. */
const MIN_BODY_RATE_KIB_PER_SECOND = 32;
const MIN_BODY_RATE_BYTES_PER_SECOND =
  MIN_BODY_RATE_KIB_PER_SECOND * BYTES_PER_KIB;

/** A request the bridge refuses with a specific status and message, rather than failing it as a server fault. */
export class RequestRefusedError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RequestRefusedError";
  }
}

/** A body that is not valid JSON, or not a JSON object. */
export function invalidJsonBody(): RequestRefusedError {
  return new RequestRefusedError(HTTP_BAD_REQUEST, "Invalid JSON");
}

/**
 * Reads a request body of at most MAX_MESSAGE_BYTES. Rejects with RequestRefusedError (413) as soon as the declared length, or the bytes actually received, pass the limit, without reading on: the caller answers and the connection is closed, so the rest of an oversized body is never buffered.
 */
export async function readBoundedBody(
  req: http.IncomingMessage,
): Promise<string> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_MESSAGE_BYTES) {
    throw tooLarge();
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_MESSAGE_BYTES) {
        chunks.length = 0;
        reject(tooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString());
    });
    req.on("error", reject);
  });
}

/**
 * How long a client has to send a whole request, headers and body: the time a body of the largest size takes at the slowest accepted rate. A request not complete by then is answered 408 and its connection closed, so a client that declares a body and stops sending cannot hold a handler and its buffered bytes for Node's default of five minutes.
 */
export const REQUEST_TIMEOUT_MS =
  (MAX_MESSAGE_BYTES / MIN_BODY_RATE_BYTES_PER_SECOND) * MS_PER_SECOND;

function tooLarge(): RequestRefusedError {
  return new RequestRefusedError(
    HTTP_PAYLOAD_TOO_LARGE,
    `Request body exceeds ${String(MAX_MESSAGE_BYTES)} bytes`,
  );
}

/**
 * Runs a route's asynchronous work and answers the request with its failure, so no rejection is left unhandled. A refusal keeps its status and message; anything else is a 500 with a fixed message (the error itself goes to `report`), since an unexpected error's text is not for the client. An answer that has already begun is ended, not started again. A refusal for size also closes the connection, so the rest of the body is not read.
 */
export function serveRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  work: () => Promise<void>,
  report: (error: Error) => void = reportToStderr,
): void {
  work().catch((err: unknown) => {
    const refused = err instanceof RequestRefusedError ? err : undefined;
    if (refused === undefined) {
      report(err instanceof Error ? err : new Error(String(err)));
    }
    if (res.headersSent || res.writableEnded) {
      res.end();
      return;
    }
    res.writeHead(refused?.status ?? HTTP_INTERNAL_SERVER_ERROR, {
      "Content-Type": "application/json",
      ...(refused?.status === HTTP_PAYLOAD_TOO_LARGE
        ? { Connection: "close" }
        : {}),
    });
    res.end(
      JSON.stringify({ error: refused?.message ?? "Internal server error" }),
      () => {
        if (refused?.status === HTTP_PAYLOAD_TOO_LARGE) req.destroy();
      },
    );
  });
}

function reportToStderr(error: Error): void {
  process.stderr.write(`agent-comms web UI: ${error.message}\n`);
}

/** The message of a failure a client may be told: a CommsError states what was refused and why, so it is shown. Anything else can quote a path or an address, so a client gets fixed text. */
export function meshErrorMessage(err: unknown): string {
  return err instanceof CommsError ? err.message : "Internal server error";
}

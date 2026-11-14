/**
 * How the web bridge reads a request body and answers a route whose work fails: every body has a maximum size, every failure of a route's asynchronous work becomes a response, and nothing a client sends can end the process.
 */

import type * as http from "node:http";

const HTTP_BAD_REQUEST = 400;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_INTERNAL_SERVER_ERROR = 500;
const BYTES_PER_KIB = 1024;
const KIB_PER_MIB = 1024;

/**
 * The most bytes the bridge reads from one HTTP request body, and accepts in one WebSocket message.
 *
 * The largest legitimate request the dashboard sends is a chat message a person typed or pasted, inside a JSON action. One mebibyte holds a pasted document of several hundred thousand characters, even with every character escaped in the JSON, which is well beyond anything a conversation carries, while keeping what one request can make the bridge hold in memory small. Every other request the dashboard sends (room, agent and read calls) is a few hundred bytes.
 */
export const MAX_REQUEST_BODY_BYTES = KIB_PER_MIB * BYTES_PER_KIB;

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
 * Reads a request body of at most MAX_REQUEST_BODY_BYTES. Rejects with RequestRefusedError (413) as soon as the declared length, or the bytes actually received, pass the limit, without reading on: the caller answers and the connection is closed, so the rest of an oversized body is never buffered.
 */
export async function readBoundedBody(
  req: http.IncomingMessage,
): Promise<string> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BODY_BYTES) {
    throw tooLarge();
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_REQUEST_BODY_BYTES) {
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

function tooLarge(): RequestRefusedError {
  return new RequestRefusedError(
    HTTP_PAYLOAD_TOO_LARGE,
    `Request body exceeds ${String(MAX_REQUEST_BODY_BYTES)} bytes`,
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

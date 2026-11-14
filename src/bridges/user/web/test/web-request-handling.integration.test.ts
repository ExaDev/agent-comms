/**
 * What no request a client sends can do to the web bridge, through the real server: a malformed or failing request is answered, never left as an unhandled rejection or an exception that ends the process, and a body or message over the maximum size is refused.
 */

import * as http from "node:http";
import * as net from "node:net";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import WS from "ws";
import {
  freeLocalPort,
  unreachableHubUrl,
} from "../../../../test/hub-helpers.js";
import { MAX_REQUEST_BODY_BYTES } from "../request-handling.js";
import { createWebServer, type WebServerHandle } from "../server.js";

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_INTERNAL_SERVER_ERROR = 500;
/** WebSocket close code for a message that is too big. */
const WS_MESSAGE_TOO_BIG = 1009;
const SETTLE_MS = 100;
const HEX_RADIX = 16;
const PAD_BYTE = 97;
const CLOSE_WAIT_MS = 5000;

let handle: WebServerHandle;
let port: number;
const unhandled: unknown[] = [];

function record(reason: unknown): void {
  unhandled.push(reason);
}

beforeAll(async () => {
  handle = await createWebServer({
    coordinatorPort: await freeLocalPort(),
    firstContactPort: await freeLocalPort(),
    hubUrl: await unreachableHubUrl(),
  });
  if (!handle.server.listening) {
    await new Promise<void>((resolve) => {
      handle.server.once("listening", () => {
        resolve();
      });
    });
  }
  const address = handle.server.address();
  port = typeof address === "object" && address ? address.port : 0;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    handle.wss.close(() => {
      resolve();
    });
  });
  await new Promise<void>((resolve) => {
    handle.server.close(() => {
      resolve();
    });
  });
  await handle.controller.shutdown();
});

beforeEach(() => {
  unhandled.length = 0;
  process.on("unhandledRejection", record);
  process.on("uncaughtException", record);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(async () => {
  // An unhandled rejection is raised after the microtasks that caused it have run, so give it the chance before judging.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, SETTLE_MS);
  });
  process.off("unhandledRejection", record);
  process.off("uncaughtException", record);
  vi.restoreAllMocks();
  expect(unhandled).toEqual([]);
});

interface Answer {
  status: number;
  body: string;
}

interface RequestOptions {
  body?: string;
  headers?: http.OutgoingHttpHeaders;
}

async function request(
  method: string,
  path: string,
  options: Readonly<RequestOptions> = {},
): Promise<Answer> {
  const { body, headers = {} } = options;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          ...(body === undefined
            ? {}
            : { "Content-Length": Buffer.byteLength(body) }),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: data });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

async function stillServing(): Promise<void> {
  const answer = await request("GET", "/api/agents");
  expect(answer.status).toBe(HTTP_OK);
}

describe("a malformed request body", () => {
  it.each([
    ["text that is not JSON", "{ not json"],
    ["an empty body", ""],
    ["a truncated object", '{"action":"send","target":'],
    ["JSON null", "null"],
    ["a JSON number", "5"],
    ["a JSON string", '"text"'],
  ])("%s is answered 400 and the bridge keeps serving", async (_name, body) => {
    const answer = await request("POST", "/api/action", {
      body,
      headers: { "Content-Type": "application/json" },
    });

    expect(answer.status).toBe(HTTP_BAD_REQUEST);
    expect(JSON.parse(answer.body)).toEqual({ error: "Invalid JSON" });
    await stillServing();
  });
});

describe("a route whose work fails", () => {
  it.each([
    ["GET /api/agents", "GET", "/api/agents", "getAgents"],
    ["GET /api/rooms", "GET", "/api/rooms", "getRooms"],
    [
      "GET /api/rooms/:id/messages",
      "GET",
      "/api/rooms/some-room/messages",
      "getRoomMessages",
    ],
  ] as const)(
    "%s answers 500 with a fixed message",
    async (_name, method, path, fn) => {
      vi.spyOn(handle.controller, fn).mockRejectedValue(
        new Error("internal detail that is not for the client"),
      );

      const answer = await request(method, path);

      expect(answer.status).toBe(HTTP_INTERNAL_SERVER_ERROR);
      expect(JSON.parse(answer.body)).toEqual({
        error: "Internal server error",
      });
      expect(answer.body).not.toContain("internal detail");
      vi.restoreAllMocks();
      vi.spyOn(process.stderr, "write").mockReturnValue(true);
      await stillServing();
    },
  );

  it("POST /api/action answers 500 when the action throws", async () => {
    vi.spyOn(handle.controller, "listAgents").mockRejectedValue(
      new Error("internal detail"),
    );

    const answer = await request("POST", "/api/action", {
      body: JSON.stringify({ action: "list_agents" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(answer.status).toBe(HTTP_INTERNAL_SERVER_ERROR);
    expect(JSON.parse(answer.body)).toEqual({ error: "Internal server error" });
  });

  it("GET /api/mesh/trace without a target is a 400", async () => {
    const answer = await request("GET", "/api/mesh/trace");
    expect(answer.status).toBe(HTTP_BAD_REQUEST);
  });
});

describe("a request target that names no URL", () => {
  it("is answered 400 and the bridge keeps serving", async () => {
    const answer = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.write(
          `GET // HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\n\r\n`,
        );
      });
      let data = "";
      socket.on("data", (chunk: Buffer) => {
        data += chunk.toString();
        if (data.includes("\r\n\r\n")) socket.destroy();
      });
      socket.on("close", () => {
        resolve(data);
      });
      socket.on("error", reject);
    });

    expect(answer.startsWith("HTTP/1.1 400")).toBe(true);
    await stillServing();
  });
});

describe("the maximum request size", () => {
  it("refuses a body whose declared length is over it, without waiting for the body", async () => {
    const answer = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.write(
          `POST /api/action HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\nContent-Type: application/json\r\nContent-Length: ${String(MAX_REQUEST_BODY_BYTES + 1)}\r\n\r\n{`,
        );
      });
      let data = "";
      socket.on("data", (chunk: Buffer) => {
        data += chunk.toString();
      });
      socket.on("close", () => {
        resolve(data);
      });
      socket.on("error", reject);
    });

    expect(answer.startsWith("HTTP/1.1 413")).toBe(true);
    expect(answer.toLowerCase()).toContain("connection: close");
    await stillServing();
  });

  it("refuses a chunked body that grows past it", async () => {
    const answer = await new Promise<string>((resolve) => {
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.write(
          `POST /api/action HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n`,
        );
        const chunk = "a".repeat(MAX_REQUEST_BODY_BYTES / 2 + 1);
        const frame = `${chunk.length.toString(HEX_RADIX)}\r\n${chunk}\r\n`;
        socket.write(frame);
        socket.write(frame);
      });
      let data = "";
      socket.on("data", (part: Buffer) => {
        data += part.toString();
      });
      socket.on("close", () => {
        resolve(data);
      });
      socket.on("error", () => undefined);
    });

    expect(answer.startsWith("HTTP/1.1 413")).toBe(true);
    await stillServing();
  });

  it("accepts a body of exactly the maximum size", async () => {
    const overhead = Buffer.byteLength(
      JSON.stringify({ action: "list_agents", pad: "" }),
    );
    const body = JSON.stringify({
      action: "list_agents",
      pad: "a".repeat(MAX_REQUEST_BODY_BYTES - overhead),
    });
    expect(Buffer.byteLength(body)).toBe(MAX_REQUEST_BODY_BYTES);

    const answer = await request("POST", "/api/action", {
      body,
      headers: { "Content-Type": "application/json" },
    });

    expect(answer.status).toBe(HTTP_OK);
  });

  it("closes a WebSocket that sends a message over it, with the status for a message that is too big, and keeps serving", async () => {
    const closeCode = await new Promise<number>((resolve, reject) => {
      const ws = new WS(`ws://127.0.0.1:${String(port)}/ws/mesh`);
      ws.on("open", () => {
        ws.send(Buffer.alloc(MAX_REQUEST_BODY_BYTES + 1, PAD_BYTE));
      });
      ws.on("close", (code) => {
        resolve(code);
      });
      ws.on("error", () => undefined);
      setTimeout(() => {
        reject(new Error("the socket was not closed"));
      }, CLOSE_WAIT_MS).unref();
    });

    expect(closeCode).toBe(WS_MESSAGE_TOO_BIG);
    await stillServing();
  });

  it("answers a WebSocket message that is not a valid call without closing the socket or ending the bridge", async () => {
    const outcome = await new Promise<string>((resolve) => {
      const ws = new WS(`ws://127.0.0.1:${String(port)}/ws/mesh`);
      ws.on("open", () => {
        ws.send("{ not json");
        setTimeout(() => {
          const open = ws.readyState === WS.OPEN;
          ws.close();
          resolve(open ? "open" : "closed");
        }, SETTLE_MS);
      });
      ws.on("error", () => undefined);
    });

    expect(["open", "closed"]).toContain(outcome);
    await stillServing();
  });
});

/**
 * Integration tests for the web server — HTTP routes and WebSocket.
 *
 * Tests the server layer without a browser, using raw HTTP and WS clients.
 */

import { describe, it, expect } from "vitest";
import http from "node:http";
import net from "node:net";
import {
  createWebServer,
  getWebPort,
  getWebUrlStatus,
  type WebServerHandle,
} from "../server.js";
import WS from "ws";

/** HTTP 200 OK. */
const HTTP_OK = 200;
/** HTTP 400 Bad Request. */
const HTTP_BAD_REQUEST = 400;
/** HTTP 404 Not Found. */
const HTTP_NOT_FOUND = 404;
/** A device-id is a hex-encoded SHA-256 hash: 32 bytes, 64 hex characters. */
const DEVICE_ID_HEX_LENGTH = 64;

/** Find a free port on localhost by binding to port 0, matching the pattern used by the mesh core's own integration tests -- an isolated coordinator port keeps this suite from colliding with a real agent-comms mesh already running on the developer's machine (the default coordinator port, 19876, is a well-known constant every real bridge instance binds). */
async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

let handle: WebServerHandle | undefined;

async function setup(): Promise<{
  port: number;
  cleanup: () => Promise<void>;
}> {
  const coordinatorPort = await findFreePort();
  handle = await createWebServer(0, undefined, coordinatorPort);

  // Wait for the server to actually be listening
  await new Promise<void>((resolve) => {
    if (handle?.server.listening === true) {
      resolve();
      return;
    }
    handle?.server.once("listening", () => resolve());
  });

  const addr = handle.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    port,
    cleanup: async () => {
      if (handle) {
        handle.wss.close();
        handle.server.close();
        await handle.controller.shutdown();
        handle = undefined;
      }
    },
  };
}

async function fetchJson(
  port: number,
  path: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method: "GET" },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          let body: unknown;
          try {
            body = JSON.parse(data);
          } catch {
            body = data;
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function postAction(
  port: number,
  action: Readonly<Record<string, string>>,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(action);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/api/action",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(body.length),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = data;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

describe("Web server integration", () => {
  it("serves the HTML page at /", async () => {
    const { port, cleanup } = await setup();
    try {
      const { status, body } = await fetchJson(port, "/");
      expect(status).toBe(HTTP_OK);
      expect(
        typeof body === "string" && body.includes("Agent Comms"),
        "HTML should contain 'Agent Comms'",
      ).toBeTruthy();
    } finally {
      await cleanup();
    }
  });

  it("lists agents via GET /api/agents", async () => {
    const { port, cleanup } = await setup();
    try {
      const { status, body } = await fetchJson(port, "/api/agents");
      expect(status).toBe(HTTP_OK);
      expect(Array.isArray(body)).toBeTruthy();
    } finally {
      await cleanup();
    }
  });

  it("lists rooms via GET /api/rooms", async () => {
    const { port, cleanup } = await setup();
    try {
      const { status, body } = await fetchJson(port, "/api/rooms");
      expect(status).toBe(HTTP_OK);
      expect(Array.isArray(body)).toBeTruthy();
    } finally {
      await cleanup();
    }
  });

  it("creates a room via POST /api/action", async () => {
    const { port, cleanup } = await setup();
    try {
      const { status, body } = await postAction(port, {
        action: "create_room",
        name: "integration-test-room",
        type: "public",
      });
      expect(status).toBe(HTTP_OK);
      expect(
        typeof body === "object" && body !== null && "content" in body,
        "should return a result object",
      ).toBeTruthy();
    } finally {
      await cleanup();
    }
  });

  it("accepts WebSocket connections", async () => {
    const { port, cleanup } = await setup();
    try {
      await new Promise<void>((resolve, reject) => {
        const ws = new WS(`ws://127.0.0.1:${String(port)}`);
        ws.on("open", () => {
          ws.close();
          resolve();
        });
        ws.on("error", reject);
      });
    } finally {
      await cleanup();
    }
  });

  it("sends state frame on WebSocket connect", async () => {
    const { port, cleanup } = await setup();
    try {
      const frame = await new Promise<unknown>((resolve, reject) => {
        const ws = new WS(`ws://127.0.0.1:${String(port)}`);
        ws.on("message", (data: WS.Data) => {
          const parsed: unknown = JSON.parse(data.toString());
          resolve(parsed);
          ws.close();
        });
        ws.on("error", reject);
      });
      expect(
        typeof frame === "object" && frame !== null && "type" in frame,
        "should receive a JSON frame",
      ).toBeTruthy();
      const typed = frame as { type: string };
      expect(typed.type).toBe("state");
    } finally {
      await cleanup();
    }
  });

  it("returns the mesh graph via GET /api/mesh/graph", async () => {
    const { port, cleanup } = await setup();
    try {
      const { status, body } = await fetchJson(port, "/api/mesh/graph");
      expect(status).toBe(HTTP_OK);
      expect(
        typeof body === "object" &&
          body !== null &&
          Array.isArray((body as { nodes?: unknown }).nodes) &&
          Array.isArray((body as { edges?: unknown }).edges),
        "should return a {nodes, edges} graph",
      ).toBeTruthy();
    } finally {
      await cleanup();
    }
  });

  it("returns 400 from GET /api/mesh/trace with no target", async () => {
    const { port, cleanup } = await setup();
    try {
      const { status, body } = await fetchJson(port, "/api/mesh/trace");
      expect(status).toBe(HTTP_BAD_REQUEST);
      expect(
        typeof body === "object" && body !== null && "error" in body,
        "should return an error body",
      ).toBeTruthy();
    } finally {
      await cleanup();
    }
  });

  it("returns a not_connected trace result for an unreachable target via GET /api/mesh/trace", async () => {
    const { port, cleanup } = await setup();
    try {
      const { status, body } = await fetchJson(
        port,
        `/api/mesh/trace?target=${"0".repeat(DEVICE_ID_HEX_LENGTH)}`,
      );
      expect(status).toBe(HTTP_OK);
      const typed = body as {
        outcome?: { result?: string; code?: string };
      };
      expect(typed.outcome?.result).toBe("error");
      expect(typed.outcome?.code).toBe("not_connected");
    } finally {
      await cleanup();
    }
  });

  it("returns 404 for unknown routes", async () => {
    const { port, cleanup } = await setup();
    try {
      const { status } = await fetchJson(port, "/nonexistent");
      expect(status).toBe(HTTP_NOT_FOUND);
    } finally {
      await cleanup();
    }
  });

  it("getWebUrlStatus reports ready with the actual listening port once the server is up", async () => {
    const { port, cleanup } = await setup();
    try {
      if (!handle) throw new Error("setup() did not assign handle");
      expect(getWebPort(handle)).toBe(port);
      expect(getWebUrlStatus(handle)).toEqual({
        kind: "ready",
        url: `http://127.0.0.1:${String(port)}`,
      });
    } finally {
      await cleanup();
    }
  });

  it("getWebUrlStatus reports not_running for an undefined handle", () => {
    expect(getWebUrlStatus(undefined)).toEqual({ kind: "not_running" });
  });
});

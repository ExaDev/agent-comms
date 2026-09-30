/**
 * The web server's LAN exposure end to end (agent-comms#346): loopback behaviour is unchanged by default, and a bind beyond loopback admits a non-loopback client only with the per-process token.
 *
 * A request to this machine's own LAN address arrives from that address, not from loopback, so it exercises the non-loopback path over a real socket. A machine with no external IPv4 address skips those cases; web-access.unit.test.ts covers the same gate without a network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as http from "node:http";
import * as os from "node:os";
import WS from "ws";
import {
  freeLocalPort,
  TeardownStack,
  unreachableHubUrl,
} from "../../../../test/hub-helpers.js";
import {
  createWebServer,
  getWebUrlStatus,
  type WebServerHandle,
} from "../server.js";
import {
  accessCookieName,
  ownInterfaceAddresses,
  WEB_HOST_ENV,
} from "../web-access.js";

const HTTP_OK = 200;
const HTTP_FOUND = 302;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;

const cleanups = new TeardownStack();

beforeEach(() => {
  vi.stubEnv(WEB_HOST_ENV, "");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await cleanups.run();
});

function lanAddress(): string | undefined {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const entry of addresses ?? []) {
      if (!entry.internal && entry.family === "IPv4") return entry.address;
    }
  }
  return undefined;
}

const LAN = lanAddress();

interface Started {
  handle: WebServerHandle;
  port: number;
}

/** By default the server is told it has no interface addresses of its own, so a request to this machine's LAN address is treated as coming from a remote device: the real thing needs a second machine. */
async function start(
  host: string | undefined,
  localClientAddresses: () => ReadonlySet<string> = () => new Set(),
): Promise<Started> {
  const handle = await createWebServer({
    host,
    localClientAddresses,
    coordinatorPort: await freeLocalPort(),
    hubUrl: await unreachableHubUrl(),
    beaconPort: await freeLocalPort(),
  });
  cleanups.push(async () => {
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
  if (!handle.server.listening) {
    await new Promise<void>((resolve) => {
      handle.server.once("listening", () => {
        resolve();
      });
    });
  }
  const address = handle.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP listen address");
  }
  return { handle, port: address.port };
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

async function call(
  target: string,
  port: number,
  options: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: target,
        port,
        method: options.method ?? "GET",
        path: options.path ?? "/api/agents",
        headers: options.headers ?? {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          });
        });
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

async function upgrade(
  target: string,
  port: number,
  headers: Readonly<Record<string, string>>,
): Promise<"open" | "rejected"> {
  return new Promise((resolve) => {
    const ws = new WS(`ws://${target}:${String(port)}/ws/mesh`, { headers });
    ws.on("open", () => {
      ws.close();
      resolve("open");
    });
    ws.on("error", () => {
      resolve("rejected");
    });
  });
}

describe("default bind", () => {
  it("listens on loopback only, with no token, and serves without credentials", async () => {
    const { handle, port } = await start(undefined);
    expect(handle.host).toBe("127.0.0.1");
    expect(handle.accessToken).toBeUndefined();
    const reply = await call("127.0.0.1", port, {});
    expect(reply.status).toBe(HTTP_OK);
  });

  it("reports its own loopback URL as the web_url", async () => {
    const { handle, port } = await start(undefined);
    expect(getWebUrlStatus(handle)).toEqual({
      kind: "ready",
      url: `http://127.0.0.1:${String(port)}`,
    });
  });
});

describe("Host check on loopback", () => {
  it("rejects a loopback request whose Host names another domain, so a rebound name cannot reach the default bind", async () => {
    const { port } = await start(undefined);
    const reply = await call("127.0.0.1", port, {
      headers: { host: `rebind.example:${String(port)}` },
    });
    expect(reply.status).toBe(HTTP_FORBIDDEN);
  });

  it("rejects a loopback request to a wildcard bind whose Host is the wildcard address", async () => {
    const { port } = await start("0.0.0.0");
    const reply = await call("127.0.0.1", port, {
      headers: { host: `0.0.0.0:${String(port)}` },
    });
    expect(reply.status).toBe(HTTP_FORBIDDEN);
  });
});

describe("bind beyond loopback", () => {
  it("prints the token URL on stderr and never on stdout", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    const { handle } = await start("0.0.0.0");
    const token = handle.accessToken;
    if (token === undefined) throw new Error("expected an access token");
    const printed = (spy: typeof stderr): string =>
      spy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(printed(stderr)).toContain(`token=${token}`);
    expect(printed(stdout)).not.toContain(token);
  });

  it("leaves loopback clients unchanged: no token needed, and web_url stays loopback", async () => {
    const { handle, port } = await start("0.0.0.0");
    const reply = await call("127.0.0.1", port, {});
    expect(reply.status).toBe(HTTP_OK);
    expect(getWebUrlStatus(handle)).toEqual({
      kind: "ready",
      url: `http://127.0.0.1:${String(port)}`,
    });
  });

  it.skipIf(LAN === undefined)(
    "rejects a LAN client without the token, for reads, POST /api/action and the websocket",
    async () => {
      const { port } = await start("0.0.0.0");
      if (LAN === undefined) throw new Error("unreachable");
      expect((await call(LAN, port, {})).status).toBe(HTTP_UNAUTHORIZED);
      const action = await call(LAN, port, {
        method: "POST",
        path: "/api/action",
        body: JSON.stringify({ action: "list_rooms" }),
      });
      expect(action.status).toBe(HTTP_UNAUTHORIZED);
      expect(await upgrade(LAN, port, {})).toBe("rejected");
      const wrong = await call(LAN, port, {
        headers: { authorization: "Bearer wrong" },
      });
      expect(wrong.status).toBe(HTTP_UNAUTHORIZED);
    },
  );

  it.skipIf(LAN === undefined)(
    "admits a LAN client with the bearer token, including a mutating action and the websocket",
    async () => {
      const { handle, port } = await start("0.0.0.0");
      if (LAN === undefined || handle.accessToken === undefined) {
        throw new Error("unreachable");
      }
      const authorization = `Bearer ${handle.accessToken}`;
      expect(
        (await call(LAN, port, { headers: { authorization } })).status,
      ).toBe(HTTP_OK);
      const action = await call(LAN, port, {
        method: "POST",
        path: "/api/action",
        headers: { authorization },
        body: JSON.stringify({ action: "list_rooms" }),
      });
      expect(action.status).toBe(HTTP_OK);
      expect(await upgrade(LAN, port, { authorization })).toBe("open");
    },
  );

  it.skipIf(LAN === undefined)(
    "exchanges the one-time URL token for a cookie that then admits the websocket",
    async () => {
      const { handle, port } = await start("0.0.0.0");
      if (LAN === undefined || handle.accessToken === undefined) {
        throw new Error("unreachable");
      }
      const exchange = await call(LAN, port, {
        path: `/?token=${handle.accessToken}`,
      });
      expect(exchange.status).toBe(HTTP_FOUND);
      expect(exchange.headers.location).toBe("/");
      const cookie = `${accessCookieName(port)}=${handle.accessToken}`;
      expect(String(exchange.headers["set-cookie"])).toContain(cookie);
      expect(await upgrade(LAN, port, { cookie })).toBe("open");
    },
  );

  it.skipIf(LAN === undefined)(
    "rejects a LAN request whose Host names another domain even with the token",
    async () => {
      const { handle, port } = await start("0.0.0.0");
      if (LAN === undefined || handle.accessToken === undefined) {
        throw new Error("unreachable");
      }
      const reply = await call(LAN, port, {
        headers: {
          host: `rebind.example:${String(port)}`,
          authorization: `Bearer ${handle.accessToken}`,
        },
      });
      expect(reply.status).toBe(HTTP_FORBIDDEN);
    },
  );

  it.skipIf(LAN === undefined)(
    "gives a specific-address bind a web_url that answers from this machine without the token",
    async () => {
      if (LAN === undefined) throw new Error("unreachable");
      const { handle, port } = await start(LAN, ownInterfaceAddresses);
      const status = getWebUrlStatus(handle);
      expect(status).toEqual({
        kind: "ready",
        url: `http://${LAN}:${String(port)}`,
      });
      const reply = await call(LAN, port, {});
      expect(reply.status).toBe(HTTP_OK);
    },
  );

  it.skipIf(LAN === undefined)(
    "treats a non-canonical wildcard spelling as a wildcard: a LAN client with the token is admitted",
    async () => {
      const { handle, port } = await start("::0");
      if (LAN === undefined || handle.accessToken === undefined) {
        throw new Error("unreachable");
      }
      expect(handle.host).toBe("::");
      const reply = await call(LAN, port, {
        headers: { authorization: `Bearer ${handle.accessToken}` },
      });
      expect(reply.status).toBe(HTTP_OK);
    },
  );
});

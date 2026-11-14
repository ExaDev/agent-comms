/**
 * Pairing through the real server: a page of the hosted dashboard's origin gets nothing, on every route and on the socket upgrade, until it presents the secret this bridge issued; a wrong or rotated secret gets nothing; and a client on this machine without that origin is unchanged.
 */

import * as http from "node:http";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WS from "ws";
import {
  freeLocalPort,
  unreachableHubUrl,
} from "../../../../test/hub-helpers.js";
import { scratchDirectory } from "../../../../test/scratch-directory.helper.js";
import {
  MESH_SUBPROTOCOL,
  PAIRING_HEADER,
  meshSocketProtocols,
} from "../pairing-protocol.js";
import { createWebServer, type WebServerHandle } from "../server.js";
import { HOSTED_DASHBOARD_ORIGIN } from "../web-access.js";
import {
  dashboardPairingUrl,
  openPairingSecret,
  rotatePairingSecret,
} from "../web-pairing.js";

const HTTP_OK = 200;
const HTTP_FORBIDDEN = 403;
const SETTLE_MS = 5000;
const SECRET_HEX_LENGTH = 64;
const WRONG_SECRET = "0".repeat(SECRET_HEX_LENGTH);
const OTHER_SITE = "https://example.org";

let handle: WebServerHandle;
let port: number;
let pairingDir: string;

beforeAll(async () => {
  pairingDir = path.join(scratchDirectory("agent-comms-pairing-server-"), "s");
  handle = await createWebServer({
    pairingDir,
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

const secret = (): string => openPairingSecret({ dir: pairingDir }).current();

interface GetOptions {
  headers?: http.OutgoingHttpHeaders | undefined;
  method?: string | undefined;
  body?: string | undefined;
}

async function get(
  pathname: string,
  options: Readonly<GetOptions> = {},
): Promise<{
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  const { headers = {}, method = "GET", body } = options;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: pathname, method, headers },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: data,
            headers: res.headers,
          });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

interface SocketOutcome {
  opened: boolean;
  protocol: string;
  status: number | undefined;
  closeCode: number | undefined;
}

/** Opens the mesh socket as a page of `origin` offering `protocols`. */
async function openSocket(
  origin: string | undefined,
  protocols: readonly string[] | undefined,
): Promise<SocketOutcome> {
  return new Promise((resolve) => {
    const ws = new WS(
      `ws://127.0.0.1:${String(port)}/ws/mesh`,
      protocols === undefined ? undefined : [...protocols],
      {
        ...(origin !== undefined && { origin }),
      },
    );
    let status: number | undefined;
    ws.on("unexpected-response", (_req, res) => {
      status = res.statusCode;
      res.resume();
      resolve({ opened: false, protocol: "", status, closeCode: undefined });
    });
    ws.on("open", () => {
      const protocol = ws.protocol;
      ws.close();
      resolve({
        opened: true,
        protocol,
        status: undefined,
        closeCode: undefined,
      });
    });
    ws.on("error", () => undefined);
    setTimeout(() => {
      resolve({ opened: false, protocol: "", status, closeCode: undefined });
    }, SETTLE_MS).unref();
  });
}

const HOSTED = { origin: HOSTED_DASHBOARD_ORIGIN };

describe("a page of the hosted dashboard's origin", () => {
  const ROUTES: readonly (readonly [string, string, string | undefined])[] = [
    ["GET", "/", undefined],
    ["GET", "/bundle.js", undefined],
    ["GET", "/index.html", undefined],
    ["GET", "/manifest.json", undefined],
    ["GET", "/api/agents", undefined],
    ["GET", "/api/rooms", undefined],
    ["GET", "/api/rooms/x/messages", undefined],
    ["GET", "/api/mesh/graph", undefined],
    ["GET", "/api/mesh/trace?target=x", undefined],
    ["POST", "/api/action", '{"action":"list_agents"}'],
    ["GET", "/pair", undefined],
    ["GET", "/nothing-here", undefined],
  ];

  it.each(ROUTES)(
    "gets nothing from %s %s without the secret",
    async (method, route, body) => {
      const answer = await get(route, { headers: { ...HOSTED }, method, body });

      expect(answer.status).toBe(HTTP_FORBIDDEN);
      expect(answer.body).toBe("Forbidden origin");
    },
  );

  it.each(ROUTES)(
    "gets nothing from %s %s with a wrong secret",
    async (method, route, body) => {
      const answer = await get(route, {
        headers: { ...HOSTED, [PAIRING_HEADER]: WRONG_SECRET },
        method,
        body,
      });

      expect(answer.status).toBe(HTTP_FORBIDDEN);
    },
  );

  it("is admitted on a route with the right secret in the header", async () => {
    const answer = await get("/api/agents", {
      headers: { ...HOSTED, [PAIRING_HEADER]: secret() },
    });

    expect(answer.status).toBe(HTTP_OK);
  });

  it("is never served the pairing page, even with the secret", async () => {
    const answer = await get("/pair", {
      headers: { ...HOSTED, [PAIRING_HEADER]: secret() },
    });

    expect(answer.status).toBe(HTTP_FORBIDDEN);
    expect(answer.body).not.toContain(secret());
  });

  it("is refused the socket upgrade without the secret", async () => {
    const outcome = await openSocket(HOSTED_DASHBOARD_ORIGIN, [
      MESH_SUBPROTOCOL,
    ]);

    expect(outcome.opened).toBe(false);
    expect(outcome.status).toBe(HTTP_FORBIDDEN);
  });

  it("is refused the socket upgrade with a wrong secret", async () => {
    const outcome = await openSocket(
      HOSTED_DASHBOARD_ORIGIN,
      meshSocketProtocols(WRONG_SECRET),
    );

    expect(outcome.opened).toBe(false);
    expect(outcome.status).toBe(HTTP_FORBIDDEN);
  });

  it("is admitted to the socket with the right secret, and the secret is not selected or echoed", async () => {
    const outcome = await openSocket(
      HOSTED_DASHBOARD_ORIGIN,
      meshSocketProtocols(secret()),
    );

    expect(outcome.opened).toBe(true);
    expect(outcome.protocol).toBe(MESH_SUBPROTOCOL);
  });

  it("is refused again after the secret is rotated, and the new one admits it", async () => {
    const before = secret();
    expect(
      (await openSocket(HOSTED_DASHBOARD_ORIGIN, meshSocketProtocols(before)))
        .opened,
    ).toBe(true);

    rotatePairingSecret(pairingDir);

    expect(
      (await openSocket(HOSTED_DASHBOARD_ORIGIN, meshSocketProtocols(before)))
        .status,
    ).toBe(HTTP_FORBIDDEN);
    expect(
      (
        await get("/api/agents", {
          headers: { ...HOSTED, [PAIRING_HEADER]: before },
        })
      ).status,
    ).toBe(HTTP_FORBIDDEN);
    expect(secret()).not.toBe(before);
    expect(
      (await openSocket(HOSTED_DASHBOARD_ORIGIN, meshSocketProtocols(secret())))
        .opened,
    ).toBe(true);
  });
});

describe("a page of another site", () => {
  it("is refused even with the right secret", async () => {
    const answer = await get("/api/agents", {
      headers: { origin: OTHER_SITE, [PAIRING_HEADER]: secret() },
    });
    const socket = await openSocket(OTHER_SITE, meshSocketProtocols(secret()));

    expect(answer.status).toBe(HTTP_FORBIDDEN);
    expect(socket.opened).toBe(false);
  });
});

describe("a client on this machine that is not the hosted dashboard", () => {
  it("is unchanged: no origin needs no secret on any route or on the socket", async () => {
    expect((await get("/api/agents")).status).toBe(HTTP_OK);
    expect((await get("/api/rooms")).status).toBe(HTTP_OK);
    expect(
      (
        await get("/api/action", {
          headers: { "Content-Type": "application/json" },
          method: "POST",
          body: '{"action":"list_agents"}',
        })
      ).status,
    ).toBe(HTTP_OK);
    const socket = await openSocket(undefined, undefined);
    expect(socket.opened).toBe(true);
  });

  it("is unchanged: this server's own origin needs no secret", async () => {
    const own = `http://127.0.0.1:${String(port)}`;

    expect(
      (await get("/api/agents", { headers: { origin: own } })).status,
    ).toBe(HTTP_OK);
    expect((await openSocket(own, undefined)).opened).toBe(true);
  });
});

describe("the pairing page", () => {
  it("is served to a person at this machine, with the link that opens the dashboard with the secret", async () => {
    const answer = await get("/pair", {
      headers: { "sec-fetch-site": "none" },
    });

    expect(answer.status).toBe(HTTP_OK);
    expect(answer.body).toContain(`href="${dashboardPairingUrl(secret())}"`);
    expect(answer.headers["x-frame-options"]).toBe("DENY");
    expect(answer.headers["cache-control"]).toBe("no-store");
  });

  it("is served without fetch metadata, as an older browser or a command-line client sends it", async () => {
    expect((await get("/pair")).status).toBe(HTTP_OK);
  });

  it.each(["cross-site", "same-site"])(
    "is refused to a request another site started (%s)",
    async (site) => {
      const answer = await get("/pair", {
        headers: { "sec-fetch-site": site },
      });

      expect(answer.status).toBe(HTTP_FORBIDDEN);
      expect(answer.body).not.toContain(secret());
    },
  );
});

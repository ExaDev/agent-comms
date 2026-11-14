/**
 * Pairing through the real server: a page of the hosted dashboard's origin reaches nothing but the proof exchange's own socket until the exchange has issued it a ticket; the exchange needs the secret this bridge issued and never carries it; a ticket opens one mesh socket; replacing the secret refuses every later proof and ticket and ends the sockets already open; and a client on this machine without that origin is unchanged.
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
  HELLO_PATH,
  MESH_PATH,
  MESH_SUBPROTOCOL,
  meshSocketProtocols,
  isHelloReply,
  isHelloTicket,
  parseHelloMessage,
} from "../pairing-protocol.js";
import { acquireTicket } from "../pairing-handshake.js";
import { createWebServer, type WebServerHandle } from "../server.js";
import { HOSTED_DASHBOARD_ORIGIN } from "../web-access.js";
import {
  dashboardPairingUrl,
  openPairingSecret,
  rotatePairingSecret,
} from "../web-pairing.js";
import {
  MAX_HELLO_MESSAGE_BYTES,
  MAX_HELLO_SOCKETS,
  ROTATION_SWEEP_MS,
  computeProof,
} from "../web-pairing-exchange.js";

const HTTP_OK = 200;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const SETTLE_MS = 5000;
const SECRET_HEX_LENGTH = 64;
const WRONG_SECRET = "0".repeat(SECRET_HEX_LENGTH);
const CLIENT_NONCE = "7".repeat(SECRET_HEX_LENGTH);
const OTHER_SITE = "https://example.org";
const CLOSE_POLICY_VIOLATION = 1008;
const CLOSE_MESSAGE_TOO_BIG = 1009;
const CLOSE_WAIT_FACTOR = 4;
const CLOSE_WAIT_MS = ROTATION_SWEEP_MS * CLOSE_WAIT_FACTOR;

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
  socket: WS | undefined;
}

/** Opens a socket at `pathname` as a page of `origin` offering `protocols`. An opened socket is left open for the caller. */
async function openSocket(
  pathname: string,
  origin: string | undefined,
  protocols: readonly string[] | undefined,
): Promise<SocketOutcome> {
  return new Promise((resolve) => {
    const ws = new WS(
      `ws://127.0.0.1:${String(port)}${pathname}`,
      protocols === undefined ? undefined : [...protocols],
      { ...(origin !== undefined && { origin }) },
    );
    ws.on("unexpected-response", (_req, res) => {
      res.resume();
      resolve({
        opened: false,
        protocol: "",
        status: res.statusCode,
        socket: undefined,
      });
    });
    ws.on("open", () => {
      resolve({
        opened: true,
        protocol: ws.protocol,
        status: undefined,
        socket: ws,
      });
    });
    ws.on("error", () => undefined);
    setTimeout(() => {
      resolve({
        opened: false,
        protocol: "",
        status: undefined,
        socket: undefined,
      });
    }, SETTLE_MS).unref();
  });
}

/** How an exchange as a page of `origin` ended: the ticket it was given, or the close code it was refused with. */
interface Exchange {
  ticket: string | undefined;
  closeCode: number | undefined;
  sent: string[];
}

/**
 * Runs the dashboard's half of the exchange by hand, as a page of `origin` holding `withSecret`, so what each side sends can be checked and a step can be broken. `tamper` may change the auth message the dashboard sends.
 */
async function exchange(
  origin: string | undefined,
  withSecret: string,
  tamper?: (proof: string) => string,
): Promise<Exchange> {
  const opened = await openSocket(HELLO_PATH, origin, undefined);
  const ws = opened.socket;
  if (ws === undefined) {
    return { ticket: undefined, closeCode: opened.status, sent: [] };
  }
  const sent: string[] = [];
  return new Promise((resolve) => {
    let ticket: string | undefined;
    const say = (message: unknown): void => {
      const text = JSON.stringify(message);
      sent.push(text);
      ws.send(text);
    };
    ws.on("message", (data) => {
      const message = parseHelloMessage(String(data));
      if (isHelloReply(message)) {
        const proof = computeProof(withSecret, {
          role: "client",
          clientNonce: CLIENT_NONCE,
          bridgeNonce: message.nonce,
          port: port,
        });
        say({
          type: "auth",
          proof: tamper === undefined ? proof : tamper(proof),
        });
      } else if (isHelloTicket(message)) {
        ticket = message.ticket;
      }
    });
    ws.on("close", (code) => {
      resolve({ ticket, closeCode: code, sent });
    });
    say({ type: "hello", nonce: CLIENT_NONCE });
    setTimeout(() => {
      ws.terminate();
    }, SETTLE_MS).unref();
  });
}

async function mesh(
  origin: string | undefined,
  ticket: string | undefined,
): Promise<SocketOutcome> {
  return openSocket(MESH_PATH, origin, meshSocketProtocols(ticket));
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
    ["GET", "/ws/hello", undefined],
    ["GET", "/nothing-here", undefined],
  ];

  it.each(ROUTES)("gets nothing from %s %s", async (method, route, body) => {
    const answer = await get(route, { headers: { ...HOSTED }, method, body });

    expect(answer.status).toBe(HTTP_FORBIDDEN);
    expect(answer.body).toBe("Forbidden origin");
  });

  it("gets nothing from a route even when it offers a valid ticket in the only place a ticket can go", async () => {
    const result = await exchange(HOSTED_DASHBOARD_ORIGIN, secret());
    expect(result.ticket).toBeDefined();

    const answer = await get("/api/agents", {
      headers: {
        ...HOSTED,
        "sec-websocket-protocol": meshSocketProtocols(result.ticket).join(", "),
      },
    });

    expect(answer.status).toBe(HTTP_FORBIDDEN);
  });

  it("is never served the pairing page", async () => {
    const answer = await get("/pair", { headers: { ...HOSTED } });

    expect(answer.status).toBe(HTTP_FORBIDDEN);
    expect(answer.body).not.toContain(secret());
  });

  it("is refused the mesh socket without a ticket, with a ticket nobody issued, and with the secret itself in the ticket's place", async () => {
    for (const protocols of [
      [MESH_SUBPROTOCOL],
      meshSocketProtocols(WRONG_SECRET),
      meshSocketProtocols(secret()),
    ]) {
      const outcome = await openSocket(
        MESH_PATH,
        HOSTED_DASHBOARD_ORIGIN,
        protocols,
      );

      expect(outcome.opened).toBe(false);
      expect(outcome.status).toBe(HTTP_FORBIDDEN);
    }
  });

  it("is given a ticket by an exchange under the secret, and the exchange never carries the secret", async () => {
    const result = await exchange(HOSTED_DASHBOARD_ORIGIN, secret());

    expect(result.ticket).toMatch(/^[0-9a-f]{64}$/);
    expect(result.sent.join("")).not.toContain(secret());
  });

  it("is admitted to the mesh socket with that ticket, once, and the ticket is not selected or echoed", async () => {
    const { ticket } = await exchange(HOSTED_DASHBOARD_ORIGIN, secret());

    const first = await mesh(HOSTED_DASHBOARD_ORIGIN, ticket);
    first.socket?.close();
    const second = await mesh(HOSTED_DASHBOARD_ORIGIN, ticket);

    expect(first.opened).toBe(true);
    expect(first.protocol).toBe(MESH_SUBPROTOCOL);
    expect(second.opened).toBe(false);
    expect(second.status).toBe(HTTP_FORBIDDEN);
  });

  it("is refused a ticket by an exchange under a wrong secret, with the same close as for any other failure", async () => {
    const result = await exchange(HOSTED_DASHBOARD_ORIGIN, WRONG_SECRET);

    expect(result.ticket).toBeUndefined();
    expect(result.closeCode).toBe(CLOSE_POLICY_VIOLATION);
  });

  it("is refused a ticket for a proof that is one digit wrong", async () => {
    const result = await exchange(
      HOSTED_DASHBOARD_ORIGIN,
      secret(),
      (proof) => `${proof.slice(0, -1)}${proof.endsWith("0") ? "1" : "0"}`,
    );

    expect(result.ticket).toBeUndefined();
    expect(result.closeCode).toBe(CLOSE_POLICY_VIOLATION);
  });

  it("is refused a ticket for a proof recorded from an earlier exchange", async () => {
    const earlier = await exchange(HOSTED_DASHBOARD_ORIGIN, secret());
    const recorded = (JSON.parse(earlier.sent[1] ?? "{}") as { proof: string })
      .proof;

    const result = await exchange(
      HOSTED_DASHBOARD_ORIGIN,
      secret(),
      () => recorded,
    );

    expect(result.ticket).toBeUndefined();
    expect(result.closeCode).toBe(CLOSE_POLICY_VIOLATION);
  });

  it("is refused any further hello socket beyond the cap, and the ones in progress still finish", async () => {
    const held: WS[] = [];
    for (let n = 0; n < MAX_HELLO_SOCKETS; n++) {
      const outcome = await openSocket(
        HELLO_PATH,
        HOSTED_DASHBOARD_ORIGIN,
        undefined,
      );
      if (outcome.socket !== undefined) held.push(outcome.socket);
    }
    const beyond = await openSocket(
      HELLO_PATH,
      HOSTED_DASHBOARD_ORIGIN,
      undefined,
    );
    for (const socket of held) socket.terminate();

    expect(held).toHaveLength(MAX_HELLO_SOCKETS);
    expect(beyond.opened).toBe(false);
    expect(beyond.status).toBe(HTTP_NOT_FOUND);
  });

  it("has a hello socket closed that sends more than one message's worth of bytes", async () => {
    const opened = await openSocket(
      HELLO_PATH,
      HOSTED_DASHBOARD_ORIGIN,
      undefined,
    );
    const ws = opened.socket;
    if (ws === undefined) throw new Error("the hello socket did not open");
    const closed = new Promise<number>((resolve) => {
      ws.on("close", (code) => {
        resolve(code);
      });
    });

    ws.send("x".repeat(MAX_HELLO_MESSAGE_BYTES + 1));

    expect(await closed).toBe(CLOSE_MESSAGE_TOO_BIG);
  });

  it("has every ticket and proof under the old secret refused after a rotation, and the new secret serves", async () => {
    const before = secret();
    const { ticket } = await exchange(HOSTED_DASHBOARD_ORIGIN, before);

    rotatePairingSecret(pairingDir);

    const stale = await mesh(HOSTED_DASHBOARD_ORIGIN, ticket);
    expect(stale.opened).toBe(false);
    expect(stale.status).toBe(HTTP_FORBIDDEN);
    expect(
      (await exchange(HOSTED_DASHBOARD_ORIGIN, before)).ticket,
    ).toBeUndefined();
    expect(secret()).not.toBe(before);
    const renewed = await exchange(HOSTED_DASHBOARD_ORIGIN, secret());
    const opened = await mesh(HOSTED_DASHBOARD_ORIGIN, renewed.ticket);
    expect(opened.opened).toBe(true);
    opened.socket?.close();
  });

  it("has a mesh socket it holds open closed within the sweep after a rotation, and one admitted after the rotation kept", async () => {
    const { ticket } = await exchange(HOSTED_DASHBOARD_ORIGIN, secret());
    const open = await mesh(HOSTED_DASHBOARD_ORIGIN, ticket);
    const ws = open.socket;
    if (ws === undefined) throw new Error("the mesh socket did not open");
    const closed = new Promise<number>((resolve) => {
      ws.on("close", (code) => {
        resolve(code);
      });
    });

    rotatePairingSecret(pairingDir);
    const afterwards = await exchange(HOSTED_DASHBOARD_ORIGIN, secret());
    const kept = await mesh(HOSTED_DASHBOARD_ORIGIN, afterwards.ticket);

    expect(
      await Promise.race([
        closed,
        new Promise<string>((resolve) => {
          setTimeout(() => {
            resolve("still open");
          }, CLOSE_WAIT_MS);
        }),
      ]),
    ).toBe(CLOSE_POLICY_VIOLATION);
    expect(kept.opened).toBe(true);
    expect(kept.socket?.readyState).toBe(WS.OPEN);
    kept.socket?.close();
  });
});

describe("a socket admitted under a secret that has been replaced", () => {
  const NEVER_SWEEP_MS = 3_600_000;

  it("is closed by the next message it sends, whatever the sweep does", async () => {
    const dir = path.join(
      scratchDirectory("agent-comms-pairing-message-"),
      "s",
    );
    const own = await createWebServer({
      pairingDir: dir,
      pairingSweepMs: NEVER_SWEEP_MS,
      coordinatorPort: await freeLocalPort(),
      firstContactPort: await freeLocalPort(),
      hubUrl: await unreachableHubUrl(),
    });
    try {
      if (!own.server.listening) {
        await new Promise<void>((resolve) => {
          own.server.once("listening", () => {
            resolve();
          });
        });
      }
      const address = own.server.address();
      const ownPort = typeof address === "object" && address ? address.port : 0;
      const ticket = await acquireTicket(
        ownPort,
        openPairingSecret({ dir }).current(),
      );
      const ws = new WS(
        `ws://127.0.0.1:${String(ownPort)}${MESH_PATH}`,
        [...meshSocketProtocols(ticket)],
        { origin: HOSTED_DASHBOARD_ORIGIN },
      );
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => {
          resolve();
        });
        ws.once("error", reject);
      });
      const closed = new Promise<number>((resolve) => {
        ws.on("close", (code) => {
          resolve(code);
        });
      });

      rotatePairingSecret(dir);
      ws.send("{}");

      expect(await closed).toBe(CLOSE_POLICY_VIOLATION);
    } finally {
      await new Promise<void>((resolve) => {
        own.wss.close(() => {
          resolve();
        });
      });
      await new Promise<void>((resolve) => {
        own.server.close(() => {
          resolve();
        });
      });
      await own.controller.shutdown();
    }
  });
});

describe("the dashboard's own half of the exchange, run against the real server", () => {
  it("gets a ticket from the bridge for the secret it holds, and none for a secret it does not", async () => {
    expect(await acquireTicket(port, secret())).toMatch(/^[0-9a-f]{64}$/);
    expect(await acquireTicket(port, WRONG_SECRET)).toBeUndefined();
  });
});

describe("a page of another site", () => {
  it("is refused the exchange's socket and the mesh socket, whatever it holds", async () => {
    const answer = await get("/api/agents", {
      headers: { origin: OTHER_SITE },
    });
    const hello = await openSocket(HELLO_PATH, OTHER_SITE, undefined);
    const { ticket } = await exchange(HOSTED_DASHBOARD_ORIGIN, secret());
    const socket = await mesh(OTHER_SITE, ticket);

    expect(answer.status).toBe(HTTP_FORBIDDEN);
    expect(hello.opened).toBe(false);
    expect(hello.status).toBe(HTTP_FORBIDDEN);
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
    const socket = await openSocket(MESH_PATH, undefined, undefined);
    expect(socket.opened).toBe(true);
    socket.socket?.close();
  });

  it("is unchanged: this server's own origin needs no secret", async () => {
    const own = `http://127.0.0.1:${String(port)}`;

    expect(
      (await get("/api/agents", { headers: { origin: own } })).status,
    ).toBe(HTTP_OK);
    const socket = await openSocket(MESH_PATH, own, undefined);
    expect(socket.opened).toBe(true);
    socket.socket?.close();
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

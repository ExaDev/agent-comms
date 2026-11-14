/**
 * Web UI server — HTTP + oRPC WebSocket for browser-based chat.
 *
 * Serves a single-page frontend and exposes a JSON API over HTTP, plus a real-time oRPC endpoint (meshRouter, implementing contract.ts's meshContract) on /ws/mesh -- state sync, state patches, delivery events, and every mutating action all go through this one endpoint now; there is no longer a separate hand-rolled chat socket or a second, differently-shaped mesh socket.
 *
 * REST endpoints: GET  /           → frontend HTML GET  /api/agents → list agents GET  /api/rooms  → list rooms GET  /api/rooms/:id/messages → read room messages POST /api/action → execute any CommsAction (test scaffolding only -- the real frontend drives everything through /ws/mesh) GET  /api/mesh/graph → the mesh's connection graph (agent-comms#199/#201) GET  /api/mesh/trace?target=<deviceHex>&timeoutMs=<n> → live path trace to a device
 *
 * When AGENT_COMMS_WEB_CONSOLE_DIST points at a built wire-mesh web-console (see web-console-static.ts), GET /web-console/* also serves that as an alternate, generic reference-client UI alongside the frontend above.
 */

import { once } from "node:events";
import * as http from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { RPCHandler } from "@orpc/server/websocket";
import { ChatController } from "../controller.js";
import type { MeshStore } from "../../../core/mesh-store.js";
import { CommsError } from "../../../core/store.js";
import type { MeshStatePatch } from "../../../core/wire-protocol.js";
import type { WebUrlStatus } from "../../../core/tool.js";
import { MAX_MESSAGE_BYTES } from "../../../core/message-limits.js";
import {
  createRoomAction,
  declineInviteAction,
  destroyRoomAction,
  dmAction,
  inviteAction,
  joinRoomAction,
  kickAction,
  leaveRoomAction,
  listAgentsAction,
  listRoomsAction,
  readRoomAction,
  renameAgentAction,
  sendAction,
} from "./actions.js";
import {
  getMeshGraphRead,
  getMeshTraceRead,
  getRoomMessagesRead,
} from "./reads.js";
import { MeshEventPublisher } from "./event-publisher.js";
import { meshRouter } from "./router.js";
import type { DeliveryEvent } from "../../../core/types.js";
import {
  resolveWebConsoleDist,
  serveWebConsole,
} from "./web-console-static.js";
import {
  ACCESS_QUERY_PARAM,
  accessUrls,
  authorise,
  generateAccessToken,
  localWebUrl,
  ownInterfaceAddresses,
  requiresAccessToken,
  resolveWebBindHost,
  type AccessDecision,
  type AccessPolicy,
} from "./web-access.js";
import { bridgePortRange } from "./bridge-port-range.js";
import { startWebBeacon } from "./web-beacon.js";
import {
  REQUEST_TIMEOUT_MS,
  meshErrorMessage,
  invalidJsonBody,
  readBoundedBody,
  serveRoute,
} from "./request-handling.js";
import {
  createFrontendAssetLoader,
  FrontendNotBuiltError,
  type FrontendAssets,
} from "./web-assets.js";

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_INTERNAL_SERVER_ERROR = 500;
const HTTP_NOT_IMPLEMENTED = 501;
const HTTP_SERVICE_UNAVAILABLE = 503;

// ---------------------------------------------------------------------------
// Static assets — read from the frontend build on first request
// ---------------------------------------------------------------------------

const frontendAssets = createFrontendAssetLoader(
  fileURLToPath(new URL("./dist", import.meta.url)),
);

/**
 * The frontend build output, or undefined after answering 503 because the build is absent. The server module is imported by every bridge, so a checkout without the build must still start; only the routes that serve the frontend are unavailable.
 */
/** The body of the 503 for a frontend that was never built. */
const FRONTEND_NOT_BUILT_BODY =
  "The web frontend is not built. A git checkout does not include the build output; install the npm package, or run `pnpm build:frontend` in a checkout with its development dependencies installed.";

function frontendOrUnavailable(
  res: http.ServerResponse,
): FrontendAssets | undefined {
  try {
    return frontendAssets();
  } catch (error) {
    if (!(error instanceof FrontendNotBuiltError)) throw error;
    res.writeHead(HTTP_SERVICE_UNAVAILABLE, {
      "Content-Type": "text/plain; charset=utf-8",
    });
    // Fixed text: the error's own message names the install path of this machine, which is not for a client.
    res.end(FRONTEND_NOT_BUILT_BODY);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WebServerHandle {
  server: http.Server;
  controller: ChatController;
  wss: WebSocketServer;
  publisher: MeshEventPublisher;
  /** The address the server is bound to: loopback unless the operator opted into LAN reachability (AGENT_COMMS_WEB_HOST). */
  host: string;
  /** The per-process secret every non-loopback request must present. Present only when the bind is beyond loopback; never advertised. */
  accessToken: string | undefined;
}

/** The port a web server handle holds. A handle is returned only once its server is listening, so this is undefined only after the server has been closed. */
export function getWebPort(handle: WebServerHandle): number | undefined {
  const addr = handle.server.address();
  return typeof addr === "object" && addr ? addr.port : undefined;
}

/** Resolve a bridge's own web UI address for the CommsTool web_url action, given whatever handle (if any) that bridge's own tryStartBridgeWebServer() call produced. The single place this three-way distinction is computed, shared by every bridge's `tool.getWebUrlStatus` wiring instead of each bridge re-deriving it from a raw WebServerHandle. */
export function getWebUrlStatus(
  handle: WebServerHandle | undefined,
): WebUrlStatus {
  if (!handle) return { kind: "not_running" };
  const port = getWebPort(handle);
  if (port === undefined || port === 0) return { kind: "pending" };
  return { kind: "ready", url: localWebUrl(handle.host, port) };
}

// ---------------------------------------------------------------------------
// Auto-start — called by every bridge after MeshStore.init()
// ---------------------------------------------------------------------------

/**
 * Starts the web UI for a bridge on top of the bridge's own store, so the process stays one mesh peer and one agent (the agent id is the store's peer id, before or after the agent registers). Every bridge entry point that owns a store uses this, and only the standalone dashboard command builds a controller, and so a store, of its own.
 *
 * The server binds the first free port of the bridge port range (see bridge-port-range.ts), which is where the hosted dashboard looks for a bridge, and takes an operating-system port only when the whole range is taken. Each port is bound for real rather than tested first, so bridges starting at the same moment cannot be handed the same port. `options.bridgePortBase` is the first port of the range to bind from; it defaults to the range the dashboard probes, and tests pass a free range of their own.
 */
export async function tryStartBridgeWebServer(
  store: MeshStore,
  harness: string,
  options?: Readonly<{ bridgePortBase?: number | undefined }>,
): Promise<WebServerHandle | undefined> {
  return createWebServer({
    bridgePortBase: options?.bridgePortBase,
    existingController: ChatController.fromExisting(store, {
      agentId: store.peerId,
      harness,
      cwd: process.cwd(),
      pid: process.pid,
    }),
  });
}

/** Whether a listen failure means the port is already taken. */
function isAddressInUse(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EADDRINUSE"
  );
}

/** Binds `server` to `port` on `host`; true once listening, false when the port is taken, and rejects on any other failure. */
async function tryListen(
  server: http.Server,
  port: number,
  host: string,
): Promise<boolean> {
  // once() rejects when the server emits "error" before "listening", and removes both of its listeners either way.
  const listening = once(server, "listening");
  server.listen(port, host);
  try {
    await listening;
    return true;
  } catch (error) {
    if (isAddressInUse(error)) return false;
    throw error;
  }
}

/**
 * Binds `server` to the first of `ports` that is free, in order, and returns the port it holds.
 *
 * Each port is bound for real, so a port another process takes between two attempts is simply skipped, where a test-then-bind would hand two processes the same port. Only "already in use" moves on to the next port: any other bind error rejects with that error. When `fallBackToAnyPort` is set and every port is taken the operating system picks one; when nothing could be bound the error names every port tried.
 */
async function listen(
  server: http.Server,
  host: string,
  ports: readonly number[],
  fallBackToAnyPort: boolean,
): Promise<number> {
  for (const port of ports) {
    if (await tryListen(server, port, host)) return boundPortOf(server);
  }
  if (fallBackToAnyPort && (await tryListen(server, 0, host))) {
    return boundPortOf(server);
  }
  const tried = fallBackToAnyPort
    ? [...ports.map(String), "an operating-system port"]
    : ports.map(String);
  throw new Error(
    `Agent Comms web UI: every port tried is already in use on ${host}: ${tried.join(", ")}`,
  );
}

/** The port a listening server holds. */
function boundPortOf(server: http.Server): number {
  const addr = server.address();
  if (typeof addr !== "object" || addr === null) {
    throw new Error("Agent Comms web UI: the listening server has no address");
  }
  return addr.port;
}

/**
 * Create the web server and resolve once it is listening.
 *
 * Without an explicit `port` it binds the first free port of the bridge port range, falling back to an operating-system port when the whole range is taken. An explicit `port` (0 for an operating-system port) is bound as given, and a port that is taken rejects instead of moving on. When binding fails nothing is left behind: the server is bound before the publisher, the listeners and the websocket server are created, and a controller this call created is shut down.
 *
 * Accepts an optional ChatController for reuse — bridges that already
 * have a MeshStore and agent identity pass theirs in so the web UI
 * shares the same mesh peer instead of creating a redundant one.
 * When no controller is provided (standalone runWeb mode), a fresh
 * Dashboard controller is created.
 */
export async function createWebServer(options?: {
  port?: number | undefined;
  /** The first port of the bridge port range tried when no explicit `port` is given. Defaults to the range the hosted dashboard probes; tests pass a free range so they neither wait on nor disturb a bridge running on the machine. */
  bridgePortBase?: number | undefined;
  /** The IP address to bind. Defaults to AGENT_COMMS_WEB_HOST, then loopback. A non-loopback address makes the server reachable from the LAN and turns on the access token (see web-access.ts). */
  host?: string | undefined;
  /** The addresses whose clients count as on this machine besides loopback. Defaults to every interface address of this machine; tests replace it to make a client on the machine's own address stand in for a remote device (see AccessPolicy.localClientAddresses). */
  localClientAddresses?: (() => ReadonlySet<string>) | undefined;
  /** The UDP port the LAN beacon advertises on when the bind is beyond loopback. Defaults to the first-contact port; tests pass an OS-assigned free port. */
  beaconPort?: number | undefined;
  existingController?: ChatController | undefined;
  coordinatorPort?: number | undefined;
  /** Overrides the first-contact UDP port a fresh controller's store runs presence on (ChatController's own firstContactPort); ignored when existingController is supplied. */
  firstContactPort?: number | undefined;
  /** Overrides the hub a fresh controller's own coordinator role dials on takeover -- ChatController's own hubUrl, ignored when existingController is supplied since that controller already made its own choice. See ChatController's own hubUrl doc comment. */
  hubUrl?: string | undefined;
}): Promise<WebServerHandle> {
  const {
    port,
    bridgePortBase,
    host: requestedHost,
    localClientAddresses = ownInterfaceAddresses,
    beaconPort,
    existingController,
    coordinatorPort,
    firstContactPort,
    hubUrl,
  } = options ?? {};
  const controller =
    existingController ??
    new ChatController("Dashboard", {
      coordinatorPort,
      hubUrl,
      firstContactPort,
    });
  if (!existingController) {
    await controller.init();
  }

  const webConsoleDist = resolveWebConsoleDist();

  const host = resolveWebBindHost(requestedHost, process.env);
  const accessToken = requiresAccessToken(host)
    ? generateAccessToken()
    : undefined;

  // The port is only known once the server listens (port 0 asks the OS), so the policy's port is filled in once the server is bound, before any request can arrive.
  const accessPolicy: AccessPolicy = {
    token: accessToken,
    bindHost: host,
    port: port ?? 0,
    localClientAddresses,
  };

  const server = http.createServer(
    { requestTimeout: REQUEST_TIMEOUT_MS, headersTimeout: REQUEST_TIMEOUT_MS },
    (req, res) => {
      // Every response, the fixed routes and the operator's web-console files alike, forbids a browser to guess a type other than the one declared.
      res.setHeader("X-Content-Type-Options", "nosniff");
      try {
        if (!admitRequest(accessPolicy, req, res)) return;
        handleRequest(req, res, controller, webConsoleDist);
      } catch (err) {
        // A request the synchronous routing cannot handle is answered, not thrown: an exception out of this listener would end the process.
        process.stderr.write(
          `agent-comms web UI: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        if (!res.headersSent) {
          jsonError(res, "Internal server error", HTTP_INTERNAL_SERVER_ERROR);
        } else {
          res.end();
        }
      }
    },
  );

  let boundPort: number;
  try {
    boundPort = await listen(
      server,
      host,
      port === undefined ? bridgePortRange(bridgePortBase) : [port],
      port === undefined,
    );
  } catch (error) {
    // A controller this call created is this call's to release; one passed in belongs to its caller.
    if (!existingController) await controller.shutdown();
    throw error;
  }
  accessPolicy.port = boundPort;

  const publisher = new MeshEventPublisher();
  ensurePatchListener(controller.meshStore, publisher);
  controller.on("message", (event: DeliveryEvent) => {
    publisher.publish({ kind: "delivery", event });
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
  });
  const rpcHandler = new RPCHandler(meshRouter);

  server.on("upgrade", (req, socket, head) => {
    // A socket error before or after the upgrade (a peer that resets, say) is that connection's alone.
    socket.on("error", reportSocketError);
    const decision = authorise(accessPolicy, requestOf(req));
    if (decision.kind !== "allow") {
      const status =
        decision.kind === "deny" ? decision.status : HTTP_UNAUTHORIZED;
      socket.write(
        `HTTP/1.1 ${String(status)} ${http.STATUS_CODES[status] ?? ""}\r\n\r\n`,
      );
      socket.destroy();
      return;
    }
    if (req.url === "/ws/mesh") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
    }
  });

  wss.on("connection", (ws) => {
    // A socket error (a message over the size limit closes the socket with code 1009 and raises one) is handled here: an error event with no listener would end the process.
    ws.on("error", reportSocketError);
    // RPCHandler.upgrade() wants a DOM-shaped WebSocket (addEventListener's overload set), which "ws"'s own type declarations don't structurally satisfy (its addEventListener options param is narrower than DOM's) -- .message()/.close() accept the looser { send } shape "ws" does satisfy, and are the documented manual equivalent to .upgrade().
    const context = { controller, publisher };
    ws.on("message", (data, isBinary) => {
      // "ws" types incoming data as Buffer | ArrayBuffer | Buffer[] regardless of frame type; normalise to a real Buffer first so both branches below have a type they can trust rather than calling .toString()/Uint8Array.from() on a union that could be an ArrayBuffer.
      const raw = Array.isArray(data) ? Buffer.concat(data) : data;
      const bytes = raw instanceof ArrayBuffer ? Buffer.from(raw) : raw;
      // Buffer's .buffer is typed ArrayBufferLike (Buffer can wrap a SharedArrayBuffer); RPCHandler.message() wants the narrower Uint8Array<ArrayBuffer> -- a fresh Uint8Array.from() copy is always backed by a plain ArrayBuffer, satisfying that exactly.
      const payload = isBinary ? Uint8Array.from(bytes) : bytes.toString();
      rpcHandler.message(ws, payload, { context }).catch(reportSocketError);
    });
    ws.on("close", () => {
      rpcHandler.close(ws).catch(reportSocketError);
    });
  });

  // stderr, not stdout: a stdio MCP bridge owns stdout for JSON-RPC, so any other line there is protocol noise to a strictly framed client.
  console.error(`Agent Comms web UI: ${localWebUrl(host, boundPort)}`);
  if (accessToken !== undefined) {
    announceLanAccess(
      server,
      { ...accessPolicy, token: accessToken },
      controller.meshStore.peerId,
      beaconPort,
    );
  }

  return { server, controller, wss, publisher, host, accessToken };
}

/** Reports a failure of one WebSocket connection to stderr: it only ever affects that connection. */
function reportSocketError(err: unknown): void {
  process.stderr.write(
    `agent-comms web UI: socket error: ${err instanceof Error ? err.message : String(err)}\n`,
  );
}

function requestOf(req: http.IncomingMessage): {
  method: string;
  url: string;
  remoteAddress: string | undefined;
  headers: http.IncomingHttpHeaders;
} {
  return {
    method: req.method ?? "GET",
    url: req.url ?? "/",
    remoteAddress: req.socket.remoteAddress,
    headers: req.headers,
  };
}

/** Applies the access policy to an HTTP request, answering it (401, 403, or the cookie-setting redirect of the one-time URL exchange) when it is not admitted. Returns true when the request should proceed to the normal handlers. */
function admitRequest(
  policy: Readonly<AccessPolicy>,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  const decision: AccessDecision = authorise(policy, requestOf(req));
  switch (decision.kind) {
    case "allow":
      return true;
    case "exchange":
      res.writeHead(decision.status, {
        "Set-Cookie": decision.cookie,
        Location: decision.location,
        "Cache-Control": "no-store",
      });
      res.end();
      return false;
    case "deny":
      res.writeHead(decision.status, {
        "Content-Type": "text/plain; charset=utf-8",
        ...(decision.status === HTTP_UNAUTHORIZED
          ? { "WWW-Authenticate": "Bearer" }
          : {}),
      });
      res.end(decision.message);
      return false;
    default:
      return decision satisfies never;
  }
}

/** Tells the operator how to open the LAN-reachable UI, and advertises its host and port (never the token) over the beacon port. The token lines go to stderr: stdout can be an MCP channel, and the token is a credential. */
function announceLanAccess(
  server: http.Server,
  policy: Readonly<AccessPolicy> & { readonly token: string },
  peerId: string,
  beaconPort: number | undefined,
): void {
  console.error(
    "Agent Comms web UI is reachable beyond loopback. Open one of these from a device on the network; the token is required for every non-loopback request:",
  );
  const urls = accessUrls(policy);
  if (urls.length === 0) {
    console.error(
      `No external address of this machine was found. Reach it by a name or address the network knows, at port ${String(policy.port)}, and open /?${ACCESS_QUERY_PARAM}=${policy.token}`,
    );
  }
  for (const url of urls) console.error(`  ${url}`);
  const beacon = startWebBeacon({
    peerId,
    webPort: policy.port,
    port: beaconPort,
    onError: (error) => {
      console.error(`Agent Comms web UI beacon: ${error.message}`);
    },
  });
  server.once("close", () => {
    beacon.stop();
  });
}

// ---------------------------------------------------------------------------
// Standalone mode — `npx agent-comms chat`
// ---------------------------------------------------------------------------

export async function runWeb(userName: string, port?: number): Promise<void> {
  const handle = await createWebServer({ port });
  console.log(`Connected as ${userName} (user) [${handle.controller.agentId}]`);

  // Graceful shutdown
  const cleanup = async (): Promise<void> => {
    handle.wss.close();
    handle.server.close();
    await handle.controller.shutdown();
    process.exit(0);
  };

  const shutDown = (): void => {
    cleanup().catch((err: unknown) => {
      process.stderr.write(
        `agent-comms web UI: shutdown failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    });
  };
  process.on("SIGINT", shutDown);
  process.on("SIGTERM", shutDown);
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  controller: ChatController,
  webConsoleDist: string | undefined,
): void {
  let url: URL;
  try {
    url = new URL(req.url ?? "/", `http://localhost`);
  } catch {
    // A request target that names no URL (an empty authority, say) is a bad request, not a fault.
    jsonError(res, "Bad request", HTTP_BAD_REQUEST);
    return;
  }

  // wire-mesh's web-console — an alternate, generic reference-client UI, served only when AGENT_COMMS_WEB_CONSOLE_DIST resolves to a real build.
  if (
    webConsoleDist !== undefined &&
    req.method === "GET" &&
    serveWebConsole(webConsoleDist, url.pathname, res)
  ) {
    return;
  }

  // Frontend HTML -- also served at the literal /index.html path (not just
  // /) because vite-plugin-pwa's injectManifest precache list references
  // the build output's own filename, index.html, and precaches it by
  // fetching that exact URL: a 404 there fails cache.addAll's whole batch,
  // which fails the service worker's install step, so the browser discards
  // the registration entirely.
  if (
    (url.pathname === "/" || url.pathname === "/index.html") &&
    req.method === "GET"
  ) {
    const assets = frontendOrUnavailable(res);
    if (assets === undefined) return;
    res.writeHead(HTTP_OK, { "Content-Type": "text/html; charset=utf-8" });
    res.end(assets.indexHtml);
    return;
  }

  // Frontend JS bundle
  if (url.pathname === "/bundle.js" && req.method === "GET") {
    const assets = frontendOrUnavailable(res);
    if (assets === undefined) return;
    res.writeHead(HTTP_OK, {
      "Content-Type": "application/javascript; charset=utf-8",
    });
    res.end(assets.bundleJs);
    return;
  }

  // Mesh SharedWorker bundle
  if (url.pathname === "/mesh-worker.js" && req.method === "GET") {
    const assets = frontendOrUnavailable(res);
    if (assets === undefined) return;
    res.writeHead(HTTP_OK, {
      "Content-Type": "application/javascript; charset=utf-8",
    });
    res.end(assets.meshWorkerJs);
    return;
  }

  // Service worker bundle
  if (url.pathname === "/sw.js" && req.method === "GET") {
    const assets = frontendOrUnavailable(res);
    if (assets === undefined) return;
    res.writeHead(HTTP_OK, {
      "Content-Type": "application/javascript; charset=utf-8",
      "Service-Worker-Allowed": "/",
    });
    res.end(assets.swJs);
    return;
  }

  // Web App Manifest
  if (url.pathname === "/manifest.json" && req.method === "GET") {
    const assets = frontendOrUnavailable(res);
    if (assets === undefined) return;
    res.writeHead(HTTP_OK, {
      "Content-Type": "application/manifest+json; charset=utf-8",
    });
    res.end(assets.manifestJson);
    return;
  }

  // PWA icons
  if (url.pathname.startsWith("/icons/") && req.method === "GET") {
    const filename = url.pathname.slice("/icons/".length);
    const assets = frontendOrUnavailable(res);
    if (assets === undefined) return;
    const icon = assets.icons.get(filename);
    if (icon !== undefined) {
      res.writeHead(HTTP_OK, {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=604800",
      });
      res.end(icon);
      return;
    }
  }

  // API routes
  if (url.pathname === "/api/agents" && req.method === "GET") {
    serveRoute(req, res, async () => {
      json(res, await controller.getAgents());
    });
    return;
  }

  if (url.pathname === "/api/rooms" && req.method === "GET") {
    serveRoute(req, res, async () => {
      json(res, await controller.getRooms());
    });
    return;
  }

  if (
    url.pathname.startsWith("/api/rooms/") &&
    url.pathname.endsWith("/messages") &&
    req.method === "GET"
  ) {
    serveRoute(req, res, async () => {
      const roomId = url.pathname.split("/")[3];
      if (roomId === undefined || roomId === "") {
        jsonError(res, "Room ID required", HTTP_BAD_REQUEST);
        return;
      }
      const since = url.searchParams.get("since") ?? undefined;
      const messages = await getRoomMessagesRead(controller, {
        room: roomId,
        since,
      });
      json(res, messages);
    });
    return;
  }

  if (url.pathname === "/api/mesh/graph" && req.method === "GET") {
    try {
      json(res, getMeshGraphRead(controller));
    } catch (err) {
      jsonError(
        res,
        meshErrorMessage(err),
        meshErrorStatus(err, HTTP_INTERNAL_SERVER_ERROR),
      );
    }
    return;
  }

  if (url.pathname === "/api/mesh/trace" && req.method === "GET") {
    serveRoute(req, res, async () => {
      const target = url.searchParams.get("target");
      if (target === null || target === "") {
        jsonError(res, "target query parameter required", HTTP_BAD_REQUEST);
        return;
      }
      const timeoutMsParam = url.searchParams.get("timeoutMs");
      const timeoutMs =
        timeoutMsParam !== null ? Number(timeoutMsParam) : undefined;
      try {
        const result = await getMeshTraceRead(controller, {
          target,
          timeoutMs,
        });
        json(res, result);
      } catch (err) {
        jsonError(
          res,
          meshErrorMessage(err),
          meshErrorStatus(err, HTTP_BAD_REQUEST),
        );
      }
    });
    return;
  }

  if (url.pathname === "/api/action" && req.method === "POST") {
    serveRoute(req, res, async () => {
      const body = await readBoundedBody(req);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw invalidJsonBody();
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        throw invalidJsonBody();
      }
      const params = Object.fromEntries(Object.entries(parsed));

      const result = await executeAction(controller, params);
      json(res, result);
    });
    return;
  }

  res.writeHead(HTTP_NOT_FOUND);
  res.end("Not found");
}

// ---------------------------------------------------------------------------
// Mesh state patch fan-out
// ---------------------------------------------------------------------------

/**
 * Stores this wiring has already been applied to. A WeakSet (not a single boolean) because a process can run multiple concurrent WebServerHandle instances, each with its own MeshStore (multiple bridges each starting their own web UI) -- a single once-ever flag would silently wire only the first store any handle in the process ever created, leaving every later handle's store.onPatch never set and its publisher never fed. Confirmed directly: this was the original bug behind the single boolean this replaces (frontend/mesh-worker.ts's own module-level meshPatchListenerActive), caught by a multi-test-in-one-process run where only the first test's server ever received state_patch events.
 */
const patchListenerWiredStores = new WeakSet<MeshStore>();

/**
 * Publishes every state patch the given store produces as a state_patch MeshEvent on the oRPC event stream. Called once per WebServerHandle at server-start time (createWebServer). Idempotent per store, not per process.
 */
function ensurePatchListener(
  store: MeshStore,
  publisher: MeshEventPublisher,
): void {
  if (patchListenerWiredStores.has(store)) return;
  patchListenerWiredStores.add(store);
  store.addPatchListener((patch: MeshStatePatch): void => {
    publisher.publish({ kind: "state_patch", patch });
  });
}

// ---------------------------------------------------------------------------
// Action dispatcher
// ---------------------------------------------------------------------------

async function executeAction(
  controller: ChatController,
  params: Record<string, unknown>,
): Promise<{ content: string; isError: boolean }> {
  const action = params.action;

  switch (action) {
    case "send":
      return sendAction(controller, {
        target: getString(params, "target") ?? "",
        content: getString(params, "content") ?? "",
      });
    case "dm":
      return dmAction(controller, {
        target: getString(params, "target") ?? "",
        content: getString(params, "content") ?? "",
      });
    case "join_room":
      return joinRoomAction(controller, {
        room: getString(params, "room") ?? "",
      });
    case "leave_room":
      return leaveRoomAction(controller, { room: getString(params, "room") });
    case "create_room":
      return createRoomAction(controller, {
        name: getString(params, "name") ?? "",
        type: getRoomType(params, "type") ?? "public",
        description: getString(params, "description"),
      });
    case "list_rooms":
      return listRoomsAction(controller);
    case "list_agents":
      return listAgentsAction(controller);
    case "read_room":
      return readRoomAction(controller, { room: getString(params, "room") });
    case "destroy_room":
      return destroyRoomAction(controller, {
        room: getString(params, "room") ?? "",
      });
    case "invite":
      return inviteAction(controller, {
        room: getString(params, "room") ?? "",
        agent: getString(params, "agent") ?? "",
      });
    case "decline_invite":
      return declineInviteAction(controller, {
        room: getString(params, "room") ?? "",
        reason: getString(params, "reason") ?? "",
      });
    case "kick":
      return kickAction(controller, {
        room: getString(params, "room") ?? "",
        agent: getString(params, "agent") ?? "",
      });
    case "rename_agent":
      return renameAgentAction(controller, {
        agent: getString(params, "agent") ?? "",
        name: getString(params, "name") ?? "",
      });
    default:
      return { content: `Unknown action: ${String(action)}`, isError: true };
  }
}

// ---------------------------------------------------------------------------
// Param extraction (no type assertions)
// ---------------------------------------------------------------------------

function getString(
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = params[key];
  return typeof value === "string" ? value : undefined;
}

function getRoomType(
  params: Record<string, unknown>,
  key: string,
): "public" | "private" | "secret" | undefined {
  const value = params[key];
  if (value === "public" || value === "private" || value === "secret") {
    return value;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(res: http.ServerResponse, data: unknown): void {
  res.writeHead(HTTP_OK, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function jsonError(
  res: http.ServerResponse,
  message: string,
  status: number,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}

/** Extracts a reportable message from whatever meshGraph()/meshTrace() threw -- a CommsError has a real message, anything else is reported generically rather than leaking an unexpected error shape to the client. */

/** A transport that doesn't support mesh_graph/mesh_trace (CommsError code NOT_SUPPORTED, e.g. this bridge is running on FileStore rather than a real mesh) is a client-visible "this endpoint isn't available here" rather than a server fault. Any other error falls back to `otherwise` -- HTTP_BAD_REQUEST for mesh_trace, since its only other realistic failure is a malformed client-supplied target; HTTP_INTERNAL_SERVER_ERROR for mesh_graph, which takes no client input at all. */
function meshErrorStatus(err: unknown, otherwise: number): number {
  if (err instanceof CommsError && err.code === "NOT_SUPPORTED") {
    return HTTP_NOT_IMPLEMENTED;
  }
  return otherwise;
}

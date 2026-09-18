/**
 * Web UI server — HTTP + WebSocket for browser-based chat.
 *
 * Serves a single-page frontend and exposes a JSON API over HTTP
 * with real-time delivery events over WebSocket.
 *
 * REST endpoints:
 *   GET  /           → frontend HTML
 *   GET  /api/agents → list agents
 *   GET  /api/rooms  → list rooms
 *   GET  /api/rooms/:id/messages → read room messages
 *   POST /api/action → execute any CommsAction
 *   GET  /api/mesh/graph → the mesh's connection graph (agent-comms#199/#201)
 *   GET  /api/mesh/trace?target=<deviceHex>&timeoutMs=<n> → live path trace to a device
 *
 * WebSocket:
 *   Server pushes delivery events as JSON frames.
 *   Client sends action objects.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { RPCHandler } from "@orpc/server/websocket";
import { PushManager } from "../../../core/push-manager.js";
import type { PushSubscription } from "../../../core/web-push.js";
import { ChatController } from "../controller.js";
import type { MeshStore } from "../../../core/mesh-store.js";
import { CommsError } from "../../../core/store.js";
import type {
  MeshMessage,
  MeshStatePatch,
} from "../../../core/wire-protocol.js";
import type { WebUrlStatus } from "../../../core/tool.js";
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
import { MeshEventPublisher } from "./event-publisher.js";
import { meshRouter } from "./router.js";
import type { DeliveryEvent } from "../../../core/types.js";

const WEB_HOST = "127.0.0.1";

const HTTP_NO_CONTENT = 204;
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_INTERNAL_SERVER_ERROR = 500;
const HTTP_NOT_IMPLEMENTED = 501;

// ---------------------------------------------------------------------------
// Static assets — loaded into memory at module load
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const INDEX_HTML = fs.readFileSync(
  path.join(__dirname, "dist", "index.html"),
  "utf-8",
);

const BUNDLE_JS = fs.readFileSync(
  path.join(__dirname, "dist", "bundle.js"),
  "utf-8",
);

const MESH_WORKER_JS = fs.existsSync(
  path.join(__dirname, "dist", "mesh-worker.js"),
)
  ? fs.readFileSync(path.join(__dirname, "dist", "mesh-worker.js"), "utf-8")
  : "/* mesh-worker not built */";

const SW_JS = fs.readFileSync(path.join(__dirname, "dist", "sw.js"), "utf-8");

const MANIFEST_JSON = fs.readFileSync(
  path.join(__dirname, "dist", "manifest.json"),
  "utf-8",
);

function loadIcon(filename: string): Buffer {
  return fs.readFileSync(path.join(__dirname, "dist", "icons", filename));
}

const ICONS: Record<string, Buffer> = {
  "icon-96x96.svg": loadIcon("icon-96x96.svg"),
  "icon-192x192.svg": loadIcon("icon-192x192.svg"),
  "icon-512x512.svg": loadIcon("icon-512x512.svg"),
};

// ---------------------------------------------------------------------------
// Active handles — needed so HTTP handlers can reach the PushManager
// ---------------------------------------------------------------------------

const activeHandles = new Set<WebServerHandle>();

function findHandle(controller: ChatController): WebServerHandle | undefined {
  for (const handle of activeHandles) {
    if (handle.controller === controller) return handle;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WebServerHandle {
  server: http.Server;
  controller: ChatController;
  wss: WebSocketServer;
  orpcWss: WebSocketServer;
  pushManager: PushManager;
  publisher: MeshEventPublisher;
}

/** Resolve the listening port from a running web server handle, or undefined if the OS hasn't assigned one yet. */
export function getWebPort(handle: WebServerHandle): number | undefined {
  const addr = handle.server.address();
  return typeof addr === "object" && addr ? addr.port : undefined;
}

/** Resolve a bridge's own web UI address for the CommsTool web_url action, given whatever handle (if any) that bridge's own tryStartWebServer() call produced. The single place this three-way distinction is computed, shared by every bridge's `tool.getWebUrlStatus` wiring instead of each bridge re-deriving it from a raw WebServerHandle. */
export function getWebUrlStatus(
  handle: WebServerHandle | undefined,
): WebUrlStatus {
  if (!handle) return { kind: "not_running" };
  const port = getWebPort(handle);
  if (port === undefined || port === 0) return { kind: "pending" };
  return { kind: "ready", url: `http://${WEB_HOST}:${String(port)}` };
}

// ---------------------------------------------------------------------------
// Auto-start — called by every bridge after MeshStore.init()
// ---------------------------------------------------------------------------

/**
 * Start the web UI server on an OS-assigned free port.
 *
 * Uses port 0 (OS-assigned) to avoid TOCTOU races when multiple bridges
 * start web servers concurrently — the OS atomically allocates a unique
 * free port for each.
 *
 * The PWA discovery path (probe from 19877) is only used when the page is
 * served from a non-local host (e.g. GitHub Pages). When served locally
 * (the common case for bridge-started servers), the browser connects via
 * location.host directly — so the port number doesn't need to be predictable.
 */
export async function tryStartWebServer(
  controller?: ChatController,
): Promise<WebServerHandle | undefined> {
  return createWebServer(0, controller);
}

/**
 * Create and start the web server on a dynamic port.
 *
 * Accepts an optional ChatController for reuse — bridges that already
 * have a MeshStore and agent identity pass theirs in so the web UI
 * shares the same mesh peer instead of creating a redundant one.
 * When no controller is provided (standalone runWeb mode), a fresh
 * Dashboard controller is created.
 */
export async function createWebServer(
  port = 0,
  existingController?: ChatController,
  coordinatorPort?: number,
): Promise<WebServerHandle> {
  const controller =
    existingController ?? new ChatController("Dashboard", coordinatorPort);
  if (!existingController) {
    await controller.init();
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res, controller);
  });

  const pushManager = new PushManager();
  const publisher = new MeshEventPublisher();
  ensurePatchListener(controller.meshStore, publisher);
  controller.on("message", (event: DeliveryEvent) => {
    publisher.publish({ kind: "delivery", event });
  });

  // Separate WS servers for chat, legacy mesh bridge, and the new oRPC mesh endpoints -- /ws/mesh-orpc is a dark-launched addition, kept fully side-by-side with the other two until PR7 retires them.
  const wss = new WebSocketServer({ noServer: true });
  const meshWss = new WebSocketServer({ noServer: true });
  const orpcWss = new WebSocketServer({ noServer: true });
  const rpcHandler = new RPCHandler(meshRouter);

  server.on("upgrade", (req, socket, head) => {
    if (req.url === "/ws/mesh-orpc") {
      orpcWss.handleUpgrade(req, socket, head, (ws) => {
        orpcWss.emit("connection", ws, req);
      });
    } else if (req.url === "/ws/mesh") {
      meshWss.handleUpgrade(req, socket, head, (ws) => {
        meshWss.emit("connection", ws, req);
      });
    } else {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    }
  });

  wss.on("connection", (ws) => {
    handleWebSocket(ws, controller, pushManager);
  });

  meshWss.on("connection", (ws) => {
    handleMeshWebSocket(ws, controller);
  });

  orpcWss.on("connection", (ws) => {
    // RPCHandler.upgrade() wants a DOM-shaped WebSocket (addEventListener's overload set), which "ws"'s own type declarations don't structurally satisfy (its addEventListener options param is narrower than DOM's) -- .message()/.close() accept the looser { send } shape "ws" does satisfy, and are the documented manual equivalent to .upgrade().
    const context = { controller, publisher, pushManager };
    ws.on("message", (data, isBinary) => {
      // "ws" types incoming data as Buffer | ArrayBuffer | Buffer[] regardless of frame type; normalise to a real Buffer first so both branches below have a type they can trust rather than calling .toString()/Uint8Array.from() on a union that could be an ArrayBuffer.
      const raw = Array.isArray(data) ? Buffer.concat(data) : data;
      const bytes = raw instanceof ArrayBuffer ? Buffer.from(raw) : raw;
      // Buffer's .buffer is typed ArrayBufferLike (Buffer can wrap a SharedArrayBuffer); RPCHandler.message() wants the narrower Uint8Array<ArrayBuffer> -- a fresh Uint8Array.from() copy is always backed by a plain ArrayBuffer, satisfying that exactly.
      const payload = isBinary ? Uint8Array.from(bytes) : bytes.toString();
      void rpcHandler.message(ws, payload, { context });
    });
    ws.on("close", () => {
      void rpcHandler.close(ws);
    });
  });

  server.listen(port, WEB_HOST, () => {
    const addr = server.address();
    const actualPort = typeof addr === "object" && addr ? addr.port : port;
    console.log(`Agent Comms web UI: http://${WEB_HOST}:${String(actualPort)}`);
  });

  return { server, controller, wss, orpcWss, pushManager, publisher };
}

class HandleRef {
  constructor(public readonly handle: WebServerHandle) {
    activeHandles.add(handle);
  }

  dispose(): void {
    activeHandles.delete(this.handle);
  }
}

// ---------------------------------------------------------------------------
// Standalone mode — `npx agent-comms chat`
// ---------------------------------------------------------------------------

export async function runWeb(userName: string, port = 0): Promise<void> {
  const handle = await createWebServer(port);
  // Keep handle alive for cleanup — variable is intentionally unused
  new HandleRef(handle);

  handle.server.on("listening", () => {
    const addr = handle.server.address();
    const actualPort = typeof addr === "object" && addr ? addr.port : port;
    console.log(`Agent Comms web UI: http://localhost:${String(actualPort)}`);
    console.log(
      `Connected as ${userName} (user) [${handle.controller.agentId}]`,
    );
  });

  // Graceful shutdown
  const cleanup = async (): Promise<void> => {
    handle.wss.close();
    handle.orpcWss.close();
    handle.server.close();
    await handle.controller.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void cleanup();
  });
  process.on("SIGTERM", () => {
    void cleanup();
  });
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  controller: ChatController,
): void {
  const url = new URL(req.url ?? "/", `http://localhost`);

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(HTTP_NO_CONTENT);
    res.end();
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
    res.writeHead(HTTP_OK, { "Content-Type": "text/html; charset=utf-8" });
    res.end(INDEX_HTML);
    return;
  }

  // Frontend JS bundle
  if (url.pathname === "/bundle.js" && req.method === "GET") {
    res.writeHead(HTTP_OK, {
      "Content-Type": "application/javascript; charset=utf-8",
    });
    res.end(BUNDLE_JS);
    return;
  }

  // Mesh SharedWorker bundle
  if (url.pathname === "/mesh-worker.js" && req.method === "GET") {
    res.writeHead(HTTP_OK, {
      "Content-Type": "application/javascript; charset=utf-8",
    });
    res.end(MESH_WORKER_JS);
    return;
  }

  // Service worker bundle
  if (url.pathname === "/sw.js" && req.method === "GET") {
    res.writeHead(HTTP_OK, {
      "Content-Type": "application/javascript; charset=utf-8",
      "Service-Worker-Allowed": "/",
    });
    res.end(SW_JS);
    return;
  }

  // Web App Manifest
  if (url.pathname === "/manifest.json" && req.method === "GET") {
    res.writeHead(HTTP_OK, {
      "Content-Type": "application/manifest+json; charset=utf-8",
    });
    res.end(MANIFEST_JSON);
    return;
  }

  // PWA icons
  if (url.pathname.startsWith("/icons/") && req.method === "GET") {
    const filename = url.pathname.slice("/icons/".length);
    const icon = ICONS[filename];
    if (icon) {
      res.writeHead(HTTP_OK, {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=604800",
      });
      res.end(icon);
      return;
    }
  }

  // VAPID public key for push subscription
  if (url.pathname === "/api/push/vapid-key" && req.method === "GET") {
    // Lazy-initialise PushManager on first request — this endpoint
    // is only hit from the frontend when push is supported.
    const handle = findHandle(controller);
    const key = handle?.pushManager.getPublicKey() ?? "";
    json(res, { publicKey: key });
    return;
  }

  // API routes
  if (url.pathname === "/api/agents" && req.method === "GET") {
    void (async () => {
      const agents = await controller.getAgents();
      json(res, agents);
    })();
    return;
  }

  if (url.pathname === "/api/rooms" && req.method === "GET") {
    void (async () => {
      const rooms = await controller.getRooms();
      json(res, rooms);
    })();
    return;
  }

  if (
    url.pathname.startsWith("/api/rooms/") &&
    url.pathname.endsWith("/messages") &&
    req.method === "GET"
  ) {
    void (async () => {
      const roomId = url.pathname.split("/")[3];
      if (roomId === undefined || roomId === "") {
        jsonError(res, "Room ID required", HTTP_BAD_REQUEST);
        return;
      }
      const since = url.searchParams.get("since") ?? undefined;
      const messages = await controller.getRoomMessages(roomId, since);
      json(res, messages);
    })();
    return;
  }

  if (url.pathname === "/api/mesh/graph" && req.method === "GET") {
    try {
      json(res, controller.meshStore.meshGraph());
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
    void (async () => {
      const target = url.searchParams.get("target");
      if (target === null || target === "") {
        jsonError(res, "target query parameter required", HTTP_BAD_REQUEST);
        return;
      }
      const timeoutMsParam = url.searchParams.get("timeoutMs");
      const timeoutMs =
        timeoutMsParam !== null ? Number(timeoutMsParam) : undefined;
      try {
        const result = await controller.meshStore.meshTrace(target, timeoutMs);
        json(res, result);
      } catch (err) {
        jsonError(
          res,
          meshErrorMessage(err),
          meshErrorStatus(err, HTTP_BAD_REQUEST),
        );
      }
    })();
    return;
  }

  if (url.pathname === "/api/action" && req.method === "POST") {
    void (async () => {
      const body = await readBody(req);
      const parsed: unknown = JSON.parse(body);
      if (typeof parsed !== "object" || parsed === null) {
        jsonError(res, "Invalid JSON", HTTP_BAD_REQUEST);
        return;
      }
      const params = Object.fromEntries(Object.entries(parsed));

      const result = await executeAction(controller, params);
      json(res, result);
    })();
    return;
  }

  res.writeHead(HTTP_NOT_FOUND);
  res.end("Not found");
}

// ---------------------------------------------------------------------------
// WebSocket handler
// ---------------------------------------------------------------------------

function handleWebSocket(
  ws: WebSocket,
  controller: ChatController,
  pushManager: PushManager,
): void {
  // Track whether this WebSocket is alive for push fallback decisions.
  let wsAlive = true;
  // Track the agent ID if the client subscribes to push notifications.
  let pushAgentId: string | undefined;

  // Push delivery events to this client
  function onMessage(event: unknown): void {
    if (wsAlive) {
      ws.send(JSON.stringify({ type: "delivery", event }));
    }
  }

  controller.on("message", onMessage);

  ws.on("close", () => {
    wsAlive = false;
    controller.off("message", onMessage);
  });

  ws.on("message", (data) => {
    void (async () => {
      try {
        const raw =
          typeof data === "string"
            ? data
            : new TextDecoder().decode(
                data instanceof ArrayBuffer
                  ? data
                  : Buffer.isBuffer(data)
                    ? data
                    : Buffer.concat(data),
              );
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null)
          throw new Error("Invalid JSON");
        const params = Object.fromEntries(Object.entries(parsed));

        // Handle push subscription messages from the PWA
        if (params.action === "push_subscribe") {
          const sub = parsePushSubscription(params.subscription);
          if (!sub) {
            ws.send(
              JSON.stringify({
                type: "error",
                message: "Invalid push subscription",
              }),
            );
            return;
          }
          const agentId = getString(params, "agentId") ?? controller.agentId;
          pushAgentId = agentId;
          pushManager.addSubscription(agentId, sub);
          ws.send(
            JSON.stringify({
              type: "result",
              result: {
                content: "Push subscription registered",
                isError: false,
              },
            }),
          );
          return;
        }

        if (params.action === "push_unsubscribe") {
          const agentId =
            getString(params, "agentId") ?? pushAgentId ?? controller.agentId;
          pushManager.removeSubscription(agentId);
          pushAgentId = undefined;
          ws.send(
            JSON.stringify({
              type: "result",
              result: { content: "Push subscription removed", isError: false },
            }),
          );
          return;
        }

        const result = await executeAction(controller, params);
        ws.send(JSON.stringify({ type: "result", result }));
      } catch (err) {
        ws.send(
          JSON.stringify({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    })();
  });

  // Send initial state
  void (async () => {
    const agents = await controller.getAgents();
    const rooms = await controller.getRooms();
    ws.send(JSON.stringify({ type: "state", agents, rooms }));
  })();
}

// ---------------------------------------------------------------------------
// Mesh WebSocket handler — bridges browser peers to the TCP mesh
// ---------------------------------------------------------------------------

/** Active mesh WS connections — shared across handler invocations. */
const meshPeers = new Set<WebSocket>();

/**
 * Stores this wiring has already been applied to. A WeakSet (not a single boolean) because a process can run multiple concurrent WebServerHandle instances, each with its own MeshStore (multiple bridges each starting their own web UI) -- a single once-ever flag would silently wire only the first store any handle in the process ever created, leaving every later handle's store.onPatch never set and its publisher never fed. Confirmed directly: this was the original bug behind the single boolean this replaces (frontend/mesh-worker.ts's own module-level meshPatchListenerActive), caught by a multi-test-in-one-process run where only the first test's server ever received state_patch events.
 */
const patchListenerWiredStores = new WeakSet<MeshStore>();

/**
 * Wires the given store's single MeshStore.onPatch callback to do two things on every patch: forward it to legacy mesh peers (unchanged behaviour) and publish it as a state_patch MeshEvent on the new oRPC event stream. Called once per WebServerHandle at server-start time (createWebServer), rather than lazily on first /ws/mesh connection as before -- store.onPatch is a single overwritable field, so both consumers have to share one registration or the second one silently clobbers the first. Idempotent per store, not per process.
 */
function ensurePatchListener(
  store: MeshStore,
  publisher: MeshEventPublisher,
): void {
  if (patchListenerWiredStores.has(store)) return;
  patchListenerWiredStores.add(store);
  store.onPatch = (patch: MeshStatePatch): void => {
    const msg: MeshMessage = {
      method: "state_update",
      patch,
    };
    const data = JSON.stringify(msg);
    for (const peer of meshPeers) {
      if (peer.readyState === WebSocket.OPEN) {
        peer.send(data);
      }
    }
    publisher.publish({ kind: "state_patch", patch });
  };
}

/**
 * Handles a WebSocket connection on /ws/mesh.
 *
 * Sends the current mesh state as a state_sync message on connect, then forwards all mesh state patches in real-time. Browser peers send action objects which are executed through the ChatController.
 */
function handleMeshWebSocket(ws: WebSocket, controller: ChatController): void {
  const store = controller.meshStore;

  meshPeers.add(ws);

  // Send initial state_sync
  const state = store.serialise();
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ method: "state_sync", state }));
  }

  ws.on("close", () => {
    meshPeers.delete(ws);
  });

  ws.on("message", (data) => {
    void (async () => {
      try {
        const raw =
          typeof data === "string"
            ? data
            : new TextDecoder().decode(
                data instanceof ArrayBuffer
                  ? data
                  : Buffer.isBuffer(data)
                    ? data
                    : Buffer.concat(data),
              );
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null) {
          throw new Error("Invalid JSON");
        }
        const params = Object.fromEntries(Object.entries(parsed));

        // Execute action through the controller
        const result = await executeAction(controller, params);
        ws.send(JSON.stringify({ type: "result", result }));
      } catch (err) {
        ws.send(
          JSON.stringify({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    })();
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

function parsePushSubscription(value: unknown): PushSubscription | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (!("endpoint" in value) || typeof value.endpoint !== "string")
    return undefined;
  if (!("keys" in value)) return undefined;
  const keys = value.keys;
  if (typeof keys !== "object" || keys === null) return undefined;
  if (!("p256dh" in keys) || typeof keys.p256dh !== "string") return undefined;
  if (!("auth" in keys) || typeof keys.auth !== "string") return undefined;
  return {
    endpoint: value.endpoint,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
  };
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
function meshErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

/** A transport that doesn't support mesh_graph/mesh_trace (CommsError code NOT_SUPPORTED, e.g. this bridge is running on FileStore rather than a real mesh) is a client-visible "this endpoint isn't available here" rather than a server fault. Any other error falls back to `otherwise` -- HTTP_BAD_REQUEST for mesh_trace, since its only other realistic failure is a malformed client-supplied target; HTTP_INTERNAL_SERVER_ERROR for mesh_graph, which takes no client input at all. */
function meshErrorStatus(err: unknown, otherwise: number): number {
  if (err instanceof CommsError && err.code === "NOT_SUPPORTED") {
    return HTTP_NOT_IMPLEMENTED;
  }
  return otherwise;
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString());
    });
    req.on("error", reject);
  });
}

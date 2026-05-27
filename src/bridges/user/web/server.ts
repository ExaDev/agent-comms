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
import { PushManager } from "../../../core/push-manager.js";
import type { PushSubscription } from "../../../core/push-manager.js";
import { ChatController } from "../controller.js";
import type { MeshStore } from "../../../core/mesh-store.js";
import type {
  MeshMessage,
  MeshStatePatch,
} from "../../../core/wire-protocol.js";
import { findFreePort } from "./port-discovery.js";

const WEB_HOST = "127.0.0.1";

// ---------------------------------------------------------------------------
// Static assets — loaded into memory at module load
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const INDEX_HTML = fs.readFileSync(
  path.join(__dirname, "frontend", "index.html"),
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
  pushManager: PushManager;
}

// ---------------------------------------------------------------------------
// Auto-start — called by every bridge after MeshStore.init()
// ---------------------------------------------------------------------------

/**
 * Start the web UI server on an OS-assigned port.
 * Returns the server handle, or undefined if port discovery fails.
 */
export async function tryStartWebServer(
  controller?: ChatController,
  coordinatorPort?: number,
): Promise<WebServerHandle | undefined> {
  const base = (coordinatorPort ?? 19876) + 1;
  const port = await findFreePort(base);
  if (port === undefined) return undefined;
  return createWebServer(port, controller);
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
  const controller = existingController ?? new ChatController("Dashboard", coordinatorPort);
  if (!existingController) {
    await controller.init();
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res, controller);
  });

  const pushManager = new PushManager();

  // Separate WS servers for chat and mesh bridge endpoints
  const wss = new WebSocketServer({ noServer: true });
  const meshWss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    if (req.url === "/ws/mesh") {
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

  server.listen(port, WEB_HOST, () => {
    const addr = server.address();
    const actualPort = typeof addr === "object" && addr ? addr.port : port;
    console.log(`Agent Comms web UI: http://${WEB_HOST}:${String(actualPort)}`);
  });

  return { server, controller, wss, pushManager };
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
  void new HandleRef(handle);

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
    res.writeHead(204);
    res.end();
    return;
  }

  // Frontend HTML
  if (url.pathname === "/" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(INDEX_HTML);
    return;
  }

  // Frontend JS bundle
  if (url.pathname === "/bundle.js" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "application/javascript; charset=utf-8",
    });
    res.end(BUNDLE_JS);
    return;
  }

  // Mesh SharedWorker bundle
  if (url.pathname === "/mesh-worker.js" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "application/javascript; charset=utf-8",
    });
    res.end(MESH_WORKER_JS);
    return;
  }

  // Service worker bundle
  if (url.pathname === "/sw.js" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "application/javascript; charset=utf-8",
      "Service-Worker-Allowed": "/",
    });
    res.end(SW_JS);
    return;
  }

  // Web App Manifest
  if (url.pathname === "/manifest.json" && req.method === "GET") {
    res.writeHead(200, {
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
      res.writeHead(200, {
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
      if (!roomId) {
        jsonError(res, "Room ID required", 400);
        return;
      }
      const since = url.searchParams.get("since") ?? undefined;
      const messages = await controller.getRoomMessages(roomId, since);
      json(res, messages);
    })();
    return;
  }

  if (url.pathname === "/api/action" && req.method === "POST") {
    void (async () => {
      const body = await readBody(req);
      const parsed: unknown = JSON.parse(body);
      if (typeof parsed !== "object" || parsed === null) {
        jsonError(res, "Invalid JSON", 400);
        return;
      }
      const params = Object.fromEntries(Object.entries(parsed));

      const result = await executeAction(controller, params);
      json(res, result);
    })();
    return;
  }

  res.writeHead(404);
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

/** Whether the global onPatch listener has been wired. */
let meshPatchListenerActive = false;

/**
 * Ensures the global MeshStore.onPatch forwards patches to all mesh peers.
 * Called once on first connection; subsequent calls are no-ops.
 */
function ensurePatchListener(store: MeshStore): void {
  if (meshPatchListenerActive) return;
  meshPatchListenerActive = true;
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
  };
}

/**
 * Handles a WebSocket connection on /ws/mesh.
 *
 * Sends the current mesh state as a state_sync message on connect,
 * then forwards all mesh state patches in real-time. Browser peers
 * send action objects which are executed through the ChatController.
 */
function handleMeshWebSocket(ws: WebSocket, controller: ChatController): void {
  const store = controller.meshStore;

  meshPeers.add(ws);
  ensurePatchListener(store);

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
    case "send": {
      const target = getString(params, "target");
      const content = getString(params, "content");
      if (!target || !content) {
        return { content: "Missing target or content", isError: true };
      }
      return controller.send(target, content);
    }
    case "dm": {
      const target = getString(params, "target");
      const content = getString(params, "content");
      if (!target || !content) {
        return { content: "Missing target or content", isError: true };
      }
      return controller.dm(target, content);
    }
    case "join_room": {
      const room = getString(params, "room");
      if (!room) return { content: "Missing room", isError: true };
      const result = await controller.switchRoom(room);
      if (!result.isError) {
        const msgs = await controller.readRoom();
        return {
          content: `${result.content}\n${msgs.content}`,
          isError: false,
        };
      }
      return result;
    }
    case "leave_room": {
      const room = getString(params, "room");
      return controller.leaveRoom(room);
    }
    case "create_room": {
      const name = getString(params, "name");
      const type = getRoomType(params, "type") ?? "public";
      const description = getString(params, "description") ?? "";
      if (!name) return { content: "Missing name", isError: true };
      return controller.createRoom(name, type, description);
    }
    case "list_rooms":
      return controller.listRooms();
    case "list_agents":
      return controller.listAgents();
    case "read_room": {
      const room = getString(params, "room");
      return controller.readRoom(room);
    }
    case "destroy_room": {
      const room = getString(params, "room");
      if (!room) return { content: "Missing room", isError: true };
      return controller.destroyRoom(room);
    }
    case "invite": {
      const room = getString(params, "room");
      const agent = getString(params, "agent");
      if (!room || !agent)
        return { content: "Missing room or agent", isError: true };
      return controller.invite(room, agent);
    }
    case "decline_invite": {
      const room = getString(params, "room");
      const reason = getString(params, "reason");
      if (!room || !reason)
        return { content: "Missing room or reason", isError: true };
      return controller.declineInvite(room, reason);
    }
    case "kick": {
      const room = getString(params, "room");
      const agent = getString(params, "agent");
      if (!room || !agent)
        return { content: "Missing room or agent", isError: true };
      return controller.kick(room, agent);
    }
    case "rename_agent": {
      const agent = getString(params, "agent");
      const name = getString(params, "name");
      if (!agent || !name)
        return { content: "Missing agent or name", isError: true };
      return controller.renameAgent(agent, name);
    }
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
  res.writeHead(200, { "Content-Type": "application/json" });
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

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString());
    });
    req.on("error", reject);
  });
}

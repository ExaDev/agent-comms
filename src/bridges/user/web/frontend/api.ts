/**
 * API client — typed REST + WebSocket communication with the comms server.
 *
 * REST for initial data fetches, WebSocket for real-time delivery events.
 * All methods are typed against the interfaces in types.ts.
 *
 * JSON boundaries use runtime validation with type predicates — no assertions.
 */

import type {
  Action,
  ActionResult,
  AgentsResponse,
  MessagesResponse,
  RoomsResponse,
  WsFrame,
} from "./types.js";

// ---------------------------------------------------------------------------
// Runtime type validators (no Zod in browser bundle)
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAgentsResponse(value: unknown): value is AgentsResponse {
  return Array.isArray(value);
}

function isRoomsResponse(value: unknown): value is RoomsResponse {
  return Array.isArray(value);
}

function isMessagesResponse(value: unknown): value is MessagesResponse {
  return Array.isArray(value);
}

function isActionResult(value: unknown): value is ActionResult {
  if (!isObject(value)) return false;
  return (
    typeof value.content === "string" && typeof value.isError === "boolean"
  );
}

function isWsFrame(value: unknown): value is WsFrame {
  return isObject(value) && typeof value.type === "string";
}

// ---------------------------------------------------------------------------
// REST client
// ---------------------------------------------------------------------------

export async function fetchAgents(): Promise<AgentsResponse> {
  const res = await fetch("/api/agents");
  const body: unknown = await res.json();
  if (!isAgentsResponse(body)) throw new Error("Invalid agents response");
  return body;
}

export async function fetchRooms(): Promise<RoomsResponse> {
  const res = await fetch("/api/rooms");
  const body: unknown = await res.json();
  if (!isRoomsResponse(body)) throw new Error("Invalid rooms response");
  return body;
}

export async function fetchRoomMessages(
  roomId: string,
  since?: string,
): Promise<MessagesResponse> {
  const url = since
    ? `/api/rooms/${encodeURIComponent(roomId)}/messages?since=${encodeURIComponent(since)}`
    : `/api/rooms/${encodeURIComponent(roomId)}/messages`;
  const res = await fetch(url);
  const body: unknown = await res.json();
  if (!isMessagesResponse(body)) throw new Error("Invalid messages response");
  return body;
}

export async function postAction(action: Action): Promise<ActionResult> {
  const res = await fetch("/api/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(action),
  });
  const body: unknown = await res.json();
  if (!isActionResult(body)) throw new Error("Invalid action result");
  return body;
}

// ---------------------------------------------------------------------------
// WebSocket client
// ---------------------------------------------------------------------------

export interface WsEventHandler {
  onOpen?: () => void;
  onClose?: () => void;
  onFrame?: (frame: WsFrame) => void;
}

export class CommsWs {
  private ws: WebSocket | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly handler: WsEventHandler;

  constructor(handler: WsEventHandler) {
    this.handler = handler;
  }

  connect(): void {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}`);
    this.ws = ws;

    ws.onopen = () => {
      this.handler.onOpen?.();
    };

    ws.onclose = () => {
      this.handler.onClose?.();
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose will fire after this
    };

    ws.onmessage = (e: MessageEvent) => {
      const raw: unknown = JSON.parse(
        typeof e.data === "string" ? e.data : String(e.data),
      );
      if (!isWsFrame(raw)) return;
      this.handler.onFrame?.(raw);
    };
  }

  sendAction(action: Action): void {
    const ws = this.ws;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(action));
    }
  }

  disconnect(): void {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const ws = this.ws;
    if (ws) {
      ws.close();
    }
    this.ws = undefined;
  }

  private scheduleReconnect(): void {
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, 3000);
  }
}

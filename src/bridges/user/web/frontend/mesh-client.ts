/**
 * MeshClient — main-thread API for the mesh SharedWorker.
 *
 * Creates a SharedWorker from the built mesh-worker.js bundle and
 * provides a typed interface for the React frontend to:
 *
 *   - Query current mesh state (agents, rooms)
 *   - Execute actions (send, join, create room, etc.)
 *   - Subscribe to real-time state changes (patches)
 *
 * The SharedWorker maintains a single WebSocket connection to the
 * server's /ws/mesh endpoint shared across all tabs.
 */

import type { Agent, Room } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AgentIdentity = Agent;
type RoomLike = Room;

export type MeshStateListener = (state: MeshClientState) => void;

export interface MeshClientState {
  agents: AgentIdentity[];
  rooms: RoomLike[];
  connected: boolean;
}

// ---------------------------------------------------------------------------
// MeshClient
// ---------------------------------------------------------------------------

export class MeshClient {
  private worker: SharedWorker | undefined;
  private state: MeshClientState = {
    agents: [],
    rooms: [],
    connected: false,
  };
  private readonly listeners = new Set<MeshStateListener>();
  private actionCounter = 0;
  private readonly pendingActions = new Map<
    string,
    {
      resolve: (result: { content: string; isError: boolean }) => void;
      reject: (error: Error) => void;
    }
  >();

  /** Connect to the mesh SharedWorker. Idempotent. */
  connect(): void {
    if (this.worker) return;

    const worker = new SharedWorker("/mesh-worker.js");
    this.worker = worker;

    worker.port.onmessage = (event: MessageEvent) => {
      const raw: unknown = JSON.parse(
        typeof event.data === "string" ? event.data : String(event.data),
      );
      if (!isOutboundMessage(raw)) return;

      switch (raw.type) {
        case "state": {
          if (
            !("state" in raw) ||
            typeof raw.state !== "object" ||
            raw.state === null
          )
            break;
          if (!("agents" in raw.state) || !("rooms" in raw.state)) break;
          // State from mesh SharedWorker is SerialisedState — agents/rooms are Records
          this.state = {
            ...this.state,
            agents: raw.state.agents satisfies typeof this.state.agents,
            rooms: raw.state.rooms satisfies typeof this.state.rooms,
          };
          this.notify();
          break;
        }
        case "connected":
          this.state = { ...this.state, connected: true };
          this.notify();
          break;
        case "disconnected":
          this.state = { ...this.state, connected: false };
          this.notify();
          break;
        case "patch":
          // After any patch, refresh from the worker's authoritative state
          this.postToWorker({ type: "getState" });
          break;
        case "actionResult": {
          // For now, action results are broadcast — we don't correlate by ID
          // because the server doesn't echo back an action ID. The main.tsx
          // handles action results through the existing CommsWs.
          break;
        }
        case "actionError":
          break;
      }
    };

    worker.port.start();

    // Tell the worker to connect to the mesh WS endpoint
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws/mesh`;
    this.postToWorker({ type: "init", url });
  }

  /** Get the current mesh state (snapshot). */
  get(): Readonly<MeshClientState> {
    return this.state;
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  subscribe(listener: MeshStateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Send an action through the mesh worker. */
  sendAction(action: Record<string, unknown>): void {
    const id = String(++this.actionCounter);
    this.postToWorker({ type: "action", id, action });
  }

  /** Disconnect and clean up. */
  disconnect(): void {
    if (this.worker) {
      this.worker.port.close();
      this.worker = undefined;
    }
    this.pendingActions.clear();
  }

  private postToWorker(msg: unknown): void {
    if (this.worker) {
      this.worker.port.postMessage(JSON.stringify(msg));
    }
  }

  private notify(): void {
    const snapshot = this.state;
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

interface OutboundMessage {
  type: string;
  [key: string]: unknown;
}

function isOutboundMessage(value: unknown): value is OutboundMessage {
  return typeof value === "object" && value !== null && "type" in value;
}

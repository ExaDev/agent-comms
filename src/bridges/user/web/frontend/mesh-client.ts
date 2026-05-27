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

    const worker = new SharedWorker("./mesh-worker.js");
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
          const state = raw.state;
          // State from mesh SharedWorker is SerialisedState where agents/rooms
          // are Record<string, T>. Object.values on object returns any[], which
          // is the actual runtime shape.
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          const agents: AgentIdentity[] =
            typeof state.agents === "object" && state.agents !== null
              ? Object.values(state.agents)
              : [];
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          const rooms: RoomLike[] =
            typeof state.rooms === "object" && state.rooms !== null
              ? Object.values(state.rooms)
              : [];
          this.state = {
            ...this.state,
            agents,
            rooms,
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

    // Discover the web server — walk up from 19877 matching the server's
    // port discovery. If served by the local server (location.host is
    // localhost/127.0.0.1), use that directly. Otherwise probe localhost.
    const localPattern = /^(localhost|127\.\d+\.\d+\.\d+)(:\d+)?$/;
    const isLocal = localPattern.test(location.host);
    if (isLocal) {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${proto}//${location.host}/ws/mesh`;
      this.postToWorker({ type: "init", url });
    } else {
      // Standalone PWA (e.g. GitHub Pages) — probe localhost ports.
      // The web server binds at coordinatorPort + 1, walking up if taken.
      // Coordinator defaults to 19876, so web server starts at 19877.
      this.probeLocalMesh(19877, 10);
    }
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

  /**
   * Probe localhost ports sequentially for the web server's /ws/mesh endpoint.
   * Matches the server's port discovery: starts at 19877, walks up.
   * Sends an init message to the worker on first successful WS upgrade.
   */
  private probeLocalMesh(basePort: number, maxAttempts: number): void {
    let attempts = 0;

    const tryPort = (port: number): void => {
      if (attempts >= maxAttempts) return;
      attempts++;

      const url = `ws://127.0.0.1:${String(port)}/ws/mesh`;
      // Quick HTTP fetch to check if anything is listening and speaks our protocol.
      // A WebSocket upgrade would be cleaner but fetch is simpler and avoids
      // a visible WS error in the console.
      fetch(`http://127.0.0.1:${String(port)}/`, { mode: "no-cors" })
        .then(() => {
          // Something responded — try connecting via the worker
          this.postToWorker({ type: "init", url });
        })
        .catch(() => {
          tryPort(port + 1);
        });
    };

    tryPort(basePort);
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

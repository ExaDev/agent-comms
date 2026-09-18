/**
 * MeshClient — main-thread API for the mesh SharedWorker.
 *
 * Creates a SharedWorker from the built mesh-worker.js bundle and provides a typed interface for the React frontend to:
 *
 * - Query current mesh state (agents, rooms)
 * - Execute actions (send, join, create room, etc.)
 * - Subscribe to real-time state changes (patches)
 *
 * The public subscribe()/get()/disconnect()/sendAction()/connect() surface is unchanged from before the oRPC migration -- internally, agents/rooms are now driven by consuming the worker's own tab-contract.ts subscribeEvents() stream over a real oRPC message-port client, rather than parsing raw postMessage frames. The one signal the new stream doesn't yet carry as its own discrete event -- connected/disconnected, which describes the worker's own upstream socket state to the real server, not this class's own message-port channel to the worker -- is read from the legacy protocol's own "connected"/"disconnected" broadcasts, still fully live on the same port (mesh-worker.ts's own PR4 kept both protocols coexisting deliberately for exactly this kind of narrow reuse, rather than re-deriving an equivalent signal via a second, redundant mechanism).
 */

import { createORPCClient, getEventMeta } from "@orpc/client";
import { RPCLink } from "@orpc/client/message-port";
import type { ContractRouterClient } from "@orpc/contract";
import type { Agent, Room } from "./types.js";
import type { TabContract } from "./tab-contract.js";
import type { MeshEvent } from "../contract.js";
import { dispatchAction } from "./dispatch-action.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AgentIdentity = Agent;
type RoomLike = Room;
type TabClient = ContractRouterClient<TabContract>;

export type MeshStateListener = (state: MeshClientState) => void;

export interface MeshClientState {
  agents: AgentIdentity[];
  rooms: RoomLike[];
  connected: boolean;
}

/** The web server's default port when standalone (coordinator default 19876 + 1), the base port `probeLocalMesh` starts walking up from. */
const DEFAULT_WEB_SERVER_PORT = 19877;
/** How many ports above `DEFAULT_WEB_SERVER_PORT` to probe before giving up, matching the server's own port-discovery walk-up range. */
const MESH_PROBE_MAX_ATTEMPTS = 10;

// ---------------------------------------------------------------------------
// MeshClient
// ---------------------------------------------------------------------------

export class MeshClient {
  private worker: SharedWorker | undefined;
  private client: TabClient | undefined;
  private state: MeshClientState = {
    agents: [],
    rooms: [],
    connected: false,
  };
  private readonly listeners = new Set<MeshStateListener>();
  private eventPumpGeneration = 0;

  constructor() {
    if (typeof window !== "undefined") {
      // A browser MessagePort never fires its own "close" event, so nothing tells the worker a tab is gone unless the tab says so itself. pagehide (never beforeunload, which kills the bfcache and is unreliable on mobile) is the last reliable point at which this can still run.
      window.addEventListener("pagehide", () => {
        this.disconnect();
      });
    }
  }

  /** Connect to the mesh SharedWorker. Idempotent. */
  connect(): void {
    if (this.worker) return;

    const worker = new SharedWorker("./mesh-worker.js");
    this.worker = worker;

    // Legacy protocol: kept alive on this same port specifically for its connected/disconnected broadcasts (see class docstring). "state"/"patch"/"actionResult"/"actionError" frames are ignored here -- the oRPC stream pumped below is the real source for agents/rooms now.
    worker.port.onmessage = (event: MessageEvent) => {
      const raw: unknown = JSON.parse(
        typeof event.data === "string" ? event.data : String(event.data),
      );
      if (!isOutboundMessage(raw)) return;
      if (raw.type === "connected") {
        this.state = { ...this.state, connected: true };
        this.notify();
      } else if (raw.type === "disconnected") {
        this.state = { ...this.state, connected: false };
        this.notify();
      }
    };

    worker.port.start();

    const link = new RPCLink({ port: worker.port });
    const client: TabClient = createORPCClient(link);
    this.client = client;
    void this.pumpEvents(client, ++this.eventPumpGeneration);

    // Discover the web server — walk up from 19877 matching the server's port discovery. If served by the local server (location.host is localhost/127.0.0.1), use that directly. Otherwise probe localhost.
    const localPattern = /^(localhost|127\.\d+\.\d+\.\d+)(:\d+)?$/;
    const isLocal = localPattern.test(location.host);
    if (isLocal) {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${proto}//${location.host}/ws/mesh`;
      this.postLegacyInit(url);
    } else {
      // Standalone PWA (e.g. GitHub Pages) — probe localhost ports. The web server binds at coordinatorPort + 1, walking up if taken. Coordinator defaults to 19876, so web server starts at 19877.
      this.probeLocalMesh(DEFAULT_WEB_SERVER_PORT, MESH_PROBE_MAX_ATTEMPTS);
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
    const client = this.client;
    if (!client) return;
    void dispatchAction(client, action);
  }

  /** Disconnect and clean up. */
  disconnect(): void {
    const worker = this.worker;
    const client = this.client;
    this.worker = undefined;
    this.client = undefined;
    this.eventPumpGeneration++;
    if (!worker) return;
    if (client) {
      // Tell the worker to evict this port's own peer registration before closing it locally -- confirmed (mesh-worker.ts's own PR) that closing the port synchronously from inside the worker's disconnect handler would hang the call, but that's the worker's own internal sequencing; from this side, firing the call and closing once it settles (success or failure) is sufficient and never blocks the tab from actually going away.
      client
        .disconnect({})
        .catch(() => {
          // Best-effort -- the tab is going away regardless.
        })
        .finally(() => {
          worker.port.close();
        });
    } else {
      worker.port.close();
    }
  }

  /**
   * Consumes the worker's own subscribeEvents() stream for as long as this generation is current, mirroring mesh-worker.ts's own pumpEvents: resuming by lastEventId after any transport-level drop is this loop's own job, not something either RetryLinkPlugin or the underlying transport does transparently on its own (confirmed empirically in an earlier stage of this migration).
   */
  private async pumpEvents(
    client: Readonly<TabClient>,
    generation: number,
  ): Promise<void> {
    let lastEventId: string | undefined;

    while (generation === this.eventPumpGeneration) {
      try {
        const events = await client.subscribeEvents(
          lastEventId === undefined ? {} : { lastEventId },
        );
        for await (const event of events) {
          if (generation !== this.eventPumpGeneration) return;
          const meta = getEventMeta(event);
          if (meta?.id !== undefined) lastEventId = meta.id;
          this.applyMeshEvent(event);
        }
        return;
      } catch {
        // Transport dropped mid-stream. Loop back and resume from lastEventId once subscribeEvents() can succeed again.
      }
    }
  }

  private applyMeshEvent(event: Readonly<MeshEvent>): void {
    switch (event.kind) {
      case "state_sync": {
        const agentsArr = Object.values(event.state.agents).filter(isAgentLike);
        const roomsArr = Object.values(event.state.rooms).filter(isRoomLike);
        this.state = { ...this.state, agents: agentsArr, rooms: roomsArr };
        this.notify();
        break;
      }
      case "state_patch":
        this.applyPatch(event.patch);
        break;
      case "delivery":
        // Not yet wired to the UI's message list -- main.tsx's own cutover is what actually consumes delivery events; this class's own state only ever tracked agents/rooms/connected.
        break;
    }
  }

  private applyPatch(
    patch: Readonly<MeshEvent & { kind: "state_patch" }>["patch"],
  ): void {
    switch (patch.type) {
      case "agent_upsert": {
        const agents = this.state.agents.filter((a) => a.id !== patch.agent.id);
        agents.push(patch.agent);
        this.state = { ...this.state, agents };
        this.notify();
        break;
      }
      case "agent_offline": {
        const agents = this.state.agents.map((a) =>
          a.id === patch.agentId ? { ...a, status: "offline" as const } : a,
        );
        this.state = { ...this.state, agents };
        this.notify();
        break;
      }
      case "room_upsert": {
        const rooms = this.state.rooms.filter((r) => r.id !== patch.room.id);
        rooms.push(patch.room);
        this.state = { ...this.state, rooms };
        this.notify();
        break;
      }
      case "room_delete": {
        const rooms = this.state.rooms.filter((r) => r.id !== patch.roomId);
        this.state = { ...this.state, rooms };
        this.notify();
        break;
      }
      case "message_add":
      case "dm_add":
      case "delivery":
        // Message/DM history and delivery-via-patch aren't part of this class's own state -- main.tsx's own cutover reads those from elsewhere.
        break;
    }
  }

  private postLegacyInit(url: string): void {
    this.worker?.port.postMessage(JSON.stringify({ type: "init", url }));
  }

  /**
   * Probe localhost ports sequentially for the web server's /ws/mesh endpoint. Matches the server's port discovery: starts at 19877, walks up. Sends an init message to the worker on first successful WS upgrade.
   */
  private probeLocalMesh(basePort: number, maxAttempts: number): void {
    let attempts = 0;

    const tryPort = (port: number): void => {
      if (attempts >= maxAttempts) return;
      attempts++;

      const url = `ws://127.0.0.1:${String(port)}/ws/mesh`;
      // Quick HTTP fetch to check if anything is listening and speaks our protocol. A WebSocket upgrade would be cleaner but fetch is simpler and avoids a visible WS error in the console.
      fetch(`http://127.0.0.1:${String(port)}/`, { mode: "no-cors" })
        .then(() => {
          // Something responded — try connecting via the worker
          this.postLegacyInit(url);
        })
        .catch(() => {
          tryPort(port + 1);
        });
    };

    tryPort(basePort);
  }

  private notify(): void {
    const snapshot = this.state;
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

interface OutboundMessage {
  type: string;
  [key: string]: unknown;
}

function isOutboundMessage(value: unknown): value is OutboundMessage {
  return typeof value === "object" && value !== null && "type" in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAgentLike(value: unknown): value is AgentIdentity {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string"
  );
}

function isRoomLike(value: unknown): value is RoomLike {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string"
  );
}

/**
 * Wire protocol — framing, encoding, and message types for the TCP mesh.
 *
 * Transport-agnostic: carries the protocol contract between peers without
 * depending on net.Socket or any specific transport implementation. Any
 * MeshTransport implementation (WireMeshTransport is the one production
 * transport today) uses these types.
 */

import type {
  AgentIdentity,
  DeliveryEvent,
  DmMessage,
  Room,
  RoomMessage,
} from "./types.js";

// ---------------------------------------------------------------------------
// Peer info
// ---------------------------------------------------------------------------

export interface PeerInfo {
  id: string;
  port: number;
  startedAt: string;
}

// ---------------------------------------------------------------------------
// Serialised mesh state
// ---------------------------------------------------------------------------

export interface SerialisedState {
  agents: Record<string, AgentIdentity>;
  rooms: Record<string, Room>;
  messages: Record<string, RoomMessage[]>;
  dms: Record<string, DmMessage[]>;
  /**
   * Pending delivery events per target agent, replicated on every peer. A
   * returning peer replays its own queue from the first snapshot it
   * receives, so events pushed while its process was down still fire
   * onDelivery (#28).
   */
  deliveryQueues: Record<string, DeliveryEvent[]>;
}

// ---------------------------------------------------------------------------
// State patches (incremental updates)
// ---------------------------------------------------------------------------

export type MeshStatePatch =
  | { type: "agent_upsert"; agent: AgentIdentity }
  | { type: "agent_offline"; agentId: string }
  | { type: "room_upsert"; room: Room }
  | { type: "room_delete"; roomId: string }
  | { type: "message_add"; roomId: string; message: RoomMessage }
  | { type: "dm_add"; key: string; message: DmMessage }
  | { type: "delivery"; agentId: string; event: DeliveryEvent }
  | { type: "message_read"; messageId: string; readBy: string; room?: string };

// ---------------------------------------------------------------------------
// Wire message union
// ---------------------------------------------------------------------------

export type MeshMessage =
  | { method: "state_sync"; state: SerialisedState }
  | { method: "state_update"; patch: MeshStatePatch }
  | { method: "introduce"; peerId: string; dataPort: number }
  | {
      method: "connect_request";
      peerId: string;
      dataPort: number;
      name: string;
      fingerprint: string;
    }
  | { method: "peer_list"; peers: PeerInfo[] }
  | { method: "peer_joined"; peer: PeerInfo }
  | { method: "peer_left"; peerId: string }
  | { method: "become_coordinator"; peerList: PeerInfo[] }
  // Federation wire messages (coordinator-to-coordinator only)
  | { method: "fed_handshake"; meshId: string; name: string; version: string }
  | { method: "fed_ack"; meshId: string; name: string; version: string }
  | { method: "fed_agent_visible"; agent: AgentIdentity }
  | { method: "fed_agent_gone"; agentId: string }
  | { method: "fed_room_message"; roomId: string; message: RoomMessage }
  | {
      method: "fed_room_join";
      roomId: string;
      agentId: string;
      agentName: string;
    }
  | { method: "fed_room_leave"; roomId: string; agentId: string }
  | { method: "fed_ping" }
  | { method: "fed_pong" };

// ---------------------------------------------------------------------------
// Framing — newline-delimited JSON
// ---------------------------------------------------------------------------

export function encode(msg: MeshMessage): string {
  return JSON.stringify(msg) + "\n";
}

export class MessageBuffer {
  private buffer = "";

  append(data: string): unknown[] {
    this.buffer += data;
    const results: unknown[] = [];
    let idx = this.buffer.indexOf("\n");
    while (idx !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length > 0) {
        try {
          results.push(JSON.parse(line));
        } catch {
          /* skip malformed lines */
        }
      }
      idx = this.buffer.indexOf("\n");
    }
    return results;
  }
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

export function isMeshMessage(value: unknown): value is MeshMessage {
  if (typeof value !== "object" || value === null) return false;
  if (!("method" in value)) return false;
  return typeof value.method === "string";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deterministic key for a DM conversation between two agents. */
export function dmKey(a: string, b: string): string {
  const sorted = [a, b].sort();
  return `${sorted[0] ?? a}--${sorted[1] ?? b}`;
}

// ---------------------------------------------------------------------------
// Wire evolution tolerance (#31 direction 2)
// ---------------------------------------------------------------------------

/**
 * The shape a state_sync payload actually has on the wire: `SerialisedState` with every field that predates #29/#30 -- and each entity's `version` within those fields -- optional, since nothing validates this JSON.parse'd message beyond `isMeshMessage`'s bare `method` check. `SerialisedState` itself stays the fully-populated type domain logic works with elsewhere; this is deliberately narrower than `Partial<SerialisedState>` so it models only the specific absences an older build can actually produce.
 */
export interface WireStateInput {
  agents?: Record<
    string,
    Omit<AgentIdentity, "version"> & { version?: number }
  >;
  rooms?: Record<string, Omit<Room, "version"> & { version?: number }>;
  messages?: SerialisedState["messages"];
  dms?: SerialisedState["dms"];
  deliveryQueues?: SerialisedState["deliveryQueues"];
}

/**
 * Normalises a state_sync payload at the wire boundary so a snapshot from an older build — one predating the entity `version` fields (#29) or `deliveryQueues` (#30) — parses to a complete state instead of throwing in `applyStateSync`. Missing collections default to empty; missing entity versions default to 1 (a pre-versioning sender's records are treated as fresh, which is what they were when written — there was no older format). The handshake (handshake.ts) is the loud, forward-looking half of the #31 fix; this is the tolerant half for peers that never negotiate.
 */
export function normaliseWireState(state: WireStateInput): SerialisedState {
  const agents: Record<string, AgentIdentity> = {};
  for (const [id, agent] of Object.entries(state.agents ?? {})) {
    agents[id] = { ...agent, version: agent.version ?? 1 };
  }
  const rooms: Record<string, Room> = {};
  for (const [id, room] of Object.entries(state.rooms ?? {})) {
    rooms[id] = { ...room, version: room.version ?? 1 };
  }
  return {
    agents,
    rooms,
    messages: state.messages ?? {},
    dms: state.dms ?? {},
    deliveryQueues: state.deliveryQueues ?? {},
  };
}

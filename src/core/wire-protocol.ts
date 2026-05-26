/**
 * Wire protocol — framing, encoding, and message types for the TCP mesh.
 *
 * Transport-agnostic: carries the protocol contract between peers without
 * depending on net.Socket or any specific transport implementation.
 * TcpTransport, TlsTransport, and WebSocketTransport all use these types.
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
  | { method: "connect_accepted"; peerId: string; dataPort: number }
  | { method: "connect_rejected"; peerId: string; reason: string }
  | { method: "peer_list"; peers: PeerInfo[] }
  | { method: "peer_joined"; peer: PeerInfo }
  | { method: "peer_left"; peerId: string }
  | { method: "become_coordinator"; peerList: PeerInfo[] }
  | { method: "pong"; peerId: string }
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

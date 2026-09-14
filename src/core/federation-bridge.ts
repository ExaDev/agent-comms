/**
 * FederationBridge — implements FederationManager's own FedCallbacks contract as a real class rather than a closure bag, so the inbound-from-remote-mesh handling (a federated agent becoming visible/gone, a federated room's message/join/leave) and the two outbound sync queries (getVisibleAgents/getFederatedRoomMemberships) live together instead of scattered across mesh-store.ts. Split out to reduce mesh-store.ts under the repo's max-lines cap.
 */

import type { FedCallbacks } from "./federation.js";
import type { DeliveryEngine } from "./delivery-engine.js";
import type { AgentIdentity, Room, RoomMessage } from "./types.js";

/** The state and DeliveryEngine operations FederationBridge needs from MeshStore -- the core agents/rooms/messages Maps are direct references into MeshStore's own fields, and deliveryEngine is the already-constructed instance (construction order: ... -> deliveryEngine -> federationBridge -> federation), narrowed to only the membership/broadcast/delivery operations a federation callback ever needs. */
export interface FederationBridgeDeps {
  agents: Map<string, AgentIdentity>;
  rooms: Map<string, Room>;
  messages: Map<string, RoomMessage[]>;
  deliveryEngine: Pick<
    DeliveryEngine,
    | "bump"
    | "recordMemberOp"
    | "refreshMembership"
    | "broadcastPatch"
    | "deliverToRoom"
    | "deliverLocallyAndBroadcast"
  >;
}

export class FederationBridge implements FedCallbacks {
  constructor(private readonly deps: FederationBridgeDeps) {}

  /** Called when a remote agent becomes visible over a federation link -- stores it locally under a `fed:`-prefixed id to avoid collisions with local agents. */
  async onAgentVisible(agent: AgentIdentity): Promise<void> {
    const remoteId = `fed:${agent.id}@${agent.harness}`;
    const remoteAgent: AgentIdentity = {
      ...agent,
      id: remoteId,
      tags: [...agent.tags, "federated"],
    };
    this.deps.agents.set(remoteId, remoteAgent);
    await this.deps.deliveryEngine.broadcastPatch({
      type: "agent_upsert",
      agent: remoteAgent,
    });
  }

  /** Called when a remote agent goes offline/disappears -- the agentId comes from the remote mesh, so this finds the locally prefixed version. */
  async onAgentGone(agentId: string): Promise<void> {
    const prefix = `fed:${agentId}@`;
    for (const [localId, agent] of this.deps.agents) {
      if (localId.startsWith(prefix)) {
        agent.status = "offline";
        this.deps.agents.set(localId, agent);
        await this.deps.deliveryEngine.broadcastPatch({
          type: "agent_offline",
          agentId: localId,
        });
        break;
      }
    }
  }

  /** Called when a message arrives for a federated room -- stores it locally and delivers to all local room members. */
  async onRoomMessage(roomId: string, message: RoomMessage): Promise<void> {
    const room = this.deps.rooms.get(roomId);
    if (!room?.federated) return;

    const arr = this.deps.messages.get(roomId) ?? [];
    arr.push(message);
    this.deps.messages.set(roomId, arr);

    for (const memberId of room.members) {
      await this.deps.deliveryEngine.deliverLocallyAndBroadcast(memberId, {
        type: "room_message",
        message,
      });
    }
  }

  /** Called when a remote agent joins a federated room -- creates a shadow `fed:`-prefixed member and notifies local members. */
  async onRoomJoin(
    roomId: string,
    agentId: string,
    _agentName: string,
  ): Promise<void> {
    const room = this.deps.rooms.get(roomId);
    if (!room?.federated) return;

    const remoteId = `fed:${agentId}`;

    if (!room.members.includes(remoteId)) {
      this.deps.deliveryEngine.bump(room);
      this.deps.deliveryEngine.recordMemberOp(room, "member", "join", remoteId);
      this.deps.deliveryEngine.refreshMembership(room);
      this.deps.rooms.set(roomId, room);
      await this.deps.deliveryEngine.broadcastPatch({
        type: "room_upsert",
        room,
      });
    }

    await this.deps.deliveryEngine.deliverToRoom(
      roomId,
      { type: "member_joined", room: roomId, agent: remoteId },
      remoteId,
    );
  }

  /** Called when a remote agent leaves a federated room. */
  async onRoomLeave(roomId: string, agentId: string): Promise<void> {
    const room = this.deps.rooms.get(roomId);
    if (!room?.federated) return;

    const remoteId = `fed:${agentId}`;
    this.deps.deliveryEngine.bump(room);
    this.deps.deliveryEngine.recordMemberOp(room, "member", "leave", remoteId);
    this.deps.deliveryEngine.refreshMembership(room);
    this.deps.rooms.set(roomId, room);
    await this.deps.deliveryEngine.broadcastPatch({
      type: "room_upsert",
      room,
    });

    await this.deps.deliveryEngine.deliverToRoom(roomId, {
      type: "member_left",
      room: roomId,
      agent: remoteId,
    });
  }

  /** Get all visible agents in the local mesh (for syncing to new links) -- excludes agents already federated in from elsewhere, to avoid re-broadcasting them back out. */
  getVisibleAgents(): AgentIdentity[] {
    const result: AgentIdentity[] = [];
    for (const agent of this.deps.agents.values()) {
      if (agent.visibility === "visible" && !agent.id.startsWith("fed:")) {
        result.push(agent);
      }
    }
    return result;
  }

  /** Get all federated rooms and their local member lists (for syncing to new links). */
  getFederatedRoomMemberships(): Map<string, string[]> {
    const result = new Map<string, string[]>();
    for (const [roomId, room] of this.deps.rooms) {
      if (room.federated) {
        const localMembers = room.members.filter((m) => !m.startsWith("fed:"));
        result.set(roomId, localMembers);
      }
    }
    return result;
  }
}

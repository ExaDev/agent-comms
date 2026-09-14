/**
 * ConnectionApproval — inbound mesh-connection admission: queues a connection_request for the owning agent to accept/reject, and the accept/reject/list/connectToRemote/startDataServerOnly operations around it. Split out of mesh-store.ts to reduce it under the repo's max-lines cap. Owns pendingInboundConnections exclusively -- nothing outside this class ever reads or writes it.
 */

import type { DeliveryEngine } from "./delivery-engine.js";
import type { ConnectionHandle, MeshTransport } from "./transport.js";
import type { AgentIdentity, DeliveryEvent } from "./types.js";
import type { PeerInfo } from "./wire-protocol.js";

/** The state and collaborators ConnectionApproval needs from MeshStore. agents/peerInfo are direct references into MeshStore's own fields; startedAt is a readonly value copied once (MeshStore never reassigns it); the closures read MeshStore's own current peerId/transport/onDelivery, and queueDelivery is DeliveryEngine's own already-constructed method. */
export interface ConnectionApprovalDeps {
  agents: Map<string, AgentIdentity>;
  peerInfo: Map<string, PeerInfo>;
  startedAt: string;
  getPeerId: () => string;
  requireTransport: () => MeshTransport;
  getOnDelivery: () =>
    | ((agentId: string, event: DeliveryEvent) => void | Promise<void>)
    | undefined;
  queueDelivery: DeliveryEngine["queueDelivery"];
}

export class ConnectionApproval {
  private readonly pendingInboundConnections = new Map<
    string,
    { peerId: string; dataPort: number; name: string; fingerprint: string }
  >();

  constructor(private readonly deps: ConnectionApprovalDeps) {}

  handleConnectionRequest(
    handle: Readonly<ConnectionHandle>,
    request: Readonly<{
      peerId: string;
      dataPort: number;
      name: string;
      fingerprint: string;
    }>,
  ): void {
    this.pendingInboundConnections.set(handle.id, {
      peerId: request.peerId,
      dataPort: request.dataPort,
      name: request.name,
      fingerprint: request.fingerprint,
    });

    // Deliver connection_request event to the owning agent
    const connectionId = handle.id;
    const event: DeliveryEvent = {
      type: "connection_request",
      connectionId,
      peerId: request.peerId,
      dataPort: request.dataPort,
      name: request.name,
      fingerprint: request.fingerprint,
    };
    const peerId = this.deps.getPeerId();
    this.deps.queueDelivery(peerId, event);
    const onDelivery = this.deps.getOnDelivery();
    if (onDelivery) {
      void onDelivery(peerId, event);
    }
  }

  /** Accept a pending inbound connection. */
  async acceptConnection(connectionId: string): Promise<void> {
    const pending = this.pendingInboundConnections.get(connectionId);
    if (!pending) {
      throw new Error(`No pending connection ${connectionId}`);
    }
    this.pendingInboundConnections.delete(connectionId);
    const handle: ConnectionHandle = { id: connectionId };
    await this.deps.requireTransport().acceptConnection(handle);
  }

  /** Reject a pending inbound connection. */
  async rejectConnection(connectionId: string, reason: string): Promise<void> {
    const pending = this.pendingInboundConnections.get(connectionId);
    if (!pending) {
      throw new Error(`No pending connection ${connectionId}`);
    }
    this.pendingInboundConnections.delete(connectionId);
    const handle: ConnectionHandle = { id: connectionId };
    await this.deps.requireTransport().rejectConnection(handle, reason);
  }

  /** List all pending inbound connections awaiting approval. */
  listPendingConnections(): {
    connectionId: string;
    peerId: string;
    dataPort: number;
    name: string;
    fingerprint: string;
  }[] {
    return [...this.pendingInboundConnections.entries()].map(([id, info]) => ({
      connectionId: id,
      ...info,
    }));
  }

  /** Initiate an outbound connection to a remote coordinator requiring approval. Fires the connect_request and returns immediately. The connection completes asynchronously when the coordinator accepts or rejects. */
  async connectToRemote(host: string, port: number): Promise<void> {
    const peerId = this.deps.getPeerId();
    const agent = this.deps.agents.get(peerId);
    // Fire-and-forget: don't await the full approval handshake. The coordinator will either accept (triggering normal introduction flow) or reject (closing the socket). Handle rejection to avoid unhandled rejection.
    this.deps
      .requireTransport()
      .connectToRemote(
        host,
        port,
        peerId,
        this.deps.requireTransport().dataPort,
        agent?.name ?? "",
        "",
      )
      .catch(() => {
        // Rejection is expected when the coordinator denies the connection. Log silently — the calling tool already returned success.
      });

    return Promise.resolve();
  }

  /** Start only the data server without connecting to a coordinator. Used for testing scenarios where the peer connects via connectToRemote. */
  async startDataServerOnly(): Promise<void> {
    await this.deps.requireTransport().startDataServer();
    const peerId = this.deps.getPeerId();
    this.deps.peerInfo.set(peerId, {
      id: peerId,
      port: this.deps.requireTransport().dataPort,
      startedAt: this.deps.startedAt,
    });
    this.deps.requireTransport().unref();
  }
}

/**
 * HubSession -- the relay-hub connection mode (agent-comms#151), split from wire-mesh-transport.ts under the max-lines cap the same way connection-approval.ts and its siblings were. A hub connection (wss://mesh.exadev.io/) is a RELAY, not a coordinator: no connect_request/introduce approval applies. The session's own self-advert is forwarded by the hub to every other connected agent and the hub answers with a catch-up of everyone already there, so peers discover each other purely through gossip. Messages ride relay-connect pairings -- sendManageRequest's own targetDevice routing, which the session layer wraps as relay-data to exactly that device.
 */

import {
  acceptMeshSession,
  type AcceptedMeshSession,
} from "wire-mesh-core/domain/mesh-session";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import type { Frame } from "wire-mesh-core/generated/protocol";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import type { Connection } from "wire-mesh-core/ports/transport";
import type { TransportEvents } from "./transport.js";
import type { MeshMessage } from "./wire-protocol.js";
import { extractMessage } from "./room-router.js";
import { connectWsUrl } from "./ws-dial.js";
import { buildCommand, DOMAIN, FRAME_SCOPE } from "./wire-mesh-transport.js";

export interface HubSessionDeps {
  /** Resolves this node's own identity port once ready. */
  identityReady: Promise<Readonly<IdentityPort>>;
  events: Readonly<TransportEvents>;
  /** The transport's own shutdown gate -- checked around every await, the same discipline the transport itself applies. */
  isShuttingDown: () => boolean;
  /** The addresses this node advertises in its own gossip self-advert. */
  advertisedAddresses: readonly string[];
  /** Registers a frame observer + dispatch for raw frames arriving on the hub connection (the transport's own handleDataFrame path). */
  onFrame: (
    connection: Readonly<Connection>,
    frame: Readonly<Frame>,
  ) => void | Promise<void>;
  /** Tracks the session for shutdown -- every session the transport ever creates, always. */
  trackForShutdown: (session: AcceptedMeshSession) => void;
}

export class HubSession {
  private session: AcceptedMeshSession | undefined;
  private readonly hubPeersKnown = new Set<string>();

  constructor(private readonly deps: Readonly<HubSessionDeps>) {}

  /** This node's own device-id, hex-encoded -- the identifier hub peers address it by. */
  async ownDeviceHex(): Promise<string> {
    const identity = await this.deps.identityReady;
    return deviceIdToHex(identity.deviceId);
  }

  /** Whether a hub session is currently live (connect() has resolved and disconnect() hasn't run since, and the far end hasn't closed it -- watchDisconnect clears this.session when the hub's own event stream reports closed). */
  get isConnected(): boolean {
    return this.session !== undefined;
  }

  /** Drops the held hub connection. A no-op if none is live (connect() was never called, disconnect() already ran, or the hub itself already closed the session). */
  async disconnect(): Promise<void> {
    const session = this.session;
    if (session === undefined) return;
    this.session = undefined;
    await session.close();
  }

  /** The device ids (hex) of peers discovered through the hub's gossiped directory. */
  peers(): readonly string[] {
    return [...this.hubPeersKnown];
  }

  /** Dials the hub and participates as a peer (see the class doc for the discovery and routing model). */
  async connect(url: string): Promise<void> {
    const connection = await connectWsUrl(url);
    if (this.deps.isShuttingDown()) {
      await connection.close();
      return;
    }
    const identity = await this.deps.identityReady;
    const session = await acceptMeshSession(connection, identity, [DOMAIN], {
      onFrame: async (conn, frame) => this.deps.onFrame(conn, frame),
      addresses: [...this.deps.advertisedAddresses],
    });
    if (this.deps.isShuttingDown()) {
      await session.close();
      return;
    }
    this.session = session;
    this.deps.trackForShutdown(session);
    // Merge the hub's directory (its catch-up arrives as the first session events) and keep refreshing it on every subsequent one.
    void (async () => {
      for await (const event of session.events) {
        if (this.deps.isShuttingDown()) break;
        for (const entry of event.directory) {
          const hex = deviceIdToHex(entry.device);
          if (hex !== deviceIdToHex(identity.deviceId)) {
            this.hubPeersKnown.add(hex);
          }
        }
        if (event.state.status === "closed") break;
      }
    })();
    this.consume(session);
    void (async () => {
      await this.watchDisconnect(session);
    })();
  }

  /** Dispatches inbound relayed manage-requests: each is handled with a handle keyed by the SENDING device (request.fromDevice names it on relay-routed requests), so onMessage and every downstream consumer see the true origin, never the hub. Replies ride respond()'s own relay routing back. A state_sync/state_update is dropped before ever reaching onMessage/applyPatch -- see isStateMutatingMessage's own doc for why: the hub has no per-peer admission control yet (that lands in agent-comms#156), so accepting one from an arbitrary hub peer would let it directly patch this side's mesh state (a security review finding on agent-comms#169, which is what first wired a hub connection into production's default coordinator path at all). */
  private consume(session: AcceptedMeshSession): void {
    void (async () => {
      for await (const request of session.incomingManageRequests) {
        if (this.deps.isShuttingDown()) break;
        const senderHex =
          request.fromDevice !== undefined
            ? deviceIdToHex(request.fromDevice)
            : "hub-peer";
        this.hubPeersKnown.add(senderHex);
        const message = extractMessage(request.command);
        if (message !== undefined && !isStateMutatingMessage(message)) {
          this.deps.events.onMessage({ id: senderHex }, message);
        }
        await request.respond({ result: "ok" }).catch(() => undefined);
      }
    })();
  }

  private async watchDisconnect(session: AcceptedMeshSession): Promise<void> {
    for await (const event of session.events) {
      if (event.state.status === "closed") break;
    }
    if (this.session === session) {
      this.session = undefined;
    }
  }

  /** Sends one message to a hub-discovered peer through the hub's relay pairing. */
  async sendToPeer(peerDeviceHex: string, message: MeshMessage): Promise<void> {
    const session = this.session;
    if (session === undefined) {
      throw new Error("not connected to a hub");
    }
    await session.sendManageRequest(
      buildCommand(message),
      FRAME_SCOPE,
      hexToBytes(peerDeviceHex),
    );
  }
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** A state_sync or state_update carries authority to directly overwrite or patch this side's own mesh state (agents, rooms, messages, deliveries) -- on an ordinary peer session that authority is meaningful because the peer already passed connect_request/introduce approval or the coordinator's own trusted mesh membership. A hub-relayed sender has passed neither: today's hub accepts any self-generated identity and gates nothing per-peer (agent-comms#156's own future deliverable), so treating its state_sync/state_update as equally authoritative would let an arbitrary hub peer inject an outcome indistinguishable from a genuine mesh event, e.g. a spoofed inbound delivery. Every other legacy message method this session might relay is already inert on receipt (PeerLifecycle's own handleDataMessage only reacts to these two), so filtering exactly these two is a complete fix for this specific path, not a partial one. */
function isStateMutatingMessage(message: MeshMessage): boolean {
  return message.method === "state_sync" || message.method === "state_update";
}

/**
 * Pure, DI-testable wiring for one fronted session's own cc-peer-to-mesh relay (agent-comms#157) -- the "attach"/"detach" half of the default front, building a FrontedSessionRecord (front-controller.ts) from an already-constructed mesh and the front's shared cc-peer peer. Mirrors bridges/cc-peer/bridge.ts's own wireCcPeerBridge split: kept free of any real CcPeer.create()/createBridgeMeshFromIdentity construction so it's testable against fakes, with front-runtime.ts supplying the real ones.
 *
 * Reuses CcPeerRef/CcPeerInboundMessage from bridge.ts rather than redeclaring them -- the wire shape a shared front-wide peer speaks is identical to the one-shot bridge command's own peer, just addressed by pid instead of a fixed target.
 */

import { buildAction, formatDeliveryEvent } from "../../core/bridge.js";
import type { CommsTool } from "../../core/tool.js";
import type { DeliveryEvent } from "../../core/types.js";
import type { FrontedSessionRecord } from "./front-controller.js";
import type { CcPeerRosterEntryLike } from "./front.js";
import type { CcPeerInboundMessage, CcPeerRef } from "./bridge.js";

/** The narrow slice of MeshStore a fronted session's own record needs -- onDelivery to wire the mesh-to-session direction, setAgentOffline/shutdown for detachFrontedSession's own teardown. */
export interface FrontRelayStore {
  onDelivery:
    | ((agentId: string, event: DeliveryEvent) => void | Promise<void>)
    | undefined;
  setAgentOffline: (id: string) => Promise<void>;
  shutdown: () => Promise<void>;
}

/** The narrow slice of the front's shared CcPeer instance this relay needs -- just send(), since the front-wide "message" listener (front-runtime.ts) is what routes an inbound message to this record's own handleInbound in the first place, not this module. */
export interface FrontRelayPeer {
  send: (
    target: Readonly<CcPeerRef>,
    body: string,
  ) => Promise<{ msgId: string }>;
}

export interface FrontedRelayRecord extends FrontedSessionRecord {
  agentId: string;
  roomId: string;
  store: FrontRelayStore;
}

export interface BuildFrontedSessionRecordDeps {
  entry: Readonly<CcPeerRosterEntryLike>;
  agentId: string;
  roomId: string;
  store: FrontRelayStore;
  tool: Pick<CommsTool, "handle">;
  peer: FrontRelayPeer;
}

/**
 * Wires both relay directions for one fronted session and returns the record CcPeerFront tracks it under. Mesh-to-session: store.onDelivery sends the formatted event to this session's own pid via the shared peer. Session-to-mesh: the returned handleInbound (called by the front's shared "message" listener once it's matched this record by socket path) posts the message into this session's own project room, exactly as wireCcPeerBridge's own peer.on("message") handler does for the one-shot bridge command.
 */
export function buildFrontedSessionRecord(
  deps: Readonly<BuildFrontedSessionRecordDeps>,
): FrontedRelayRecord {
  const { entry, agentId, roomId, store, tool, peer } = deps;

  store.onDelivery = (_targetId, event) => {
    void peer.send({ pid: entry.pid }, formatDeliveryEvent(event));
  };

  return {
    pid: entry.pid,
    cwd: entry.cwd,
    messagingSocketPath: entry.messagingSocketPath,
    agentId,
    roomId,
    store,
    handleInbound: (message: Readonly<CcPeerInboundMessage>) => {
      const sender = message.fromName ?? message.from ?? "unknown";
      const action = buildAction({
        action: "send",
        room: roomId,
        content: `${sender}: ${message.body}`,
      });
      void tool.handle(
        {
          agentId,
          harness: "claude-code",
          cwd: entry.cwd,
          pid: process.pid,
        },
        action,
      );
    },
  };
}

/** Tears a fronted session's record down: marks its agent offline (a courtesy to peers watching its presence), then shuts its mesh store down. There is no identity lock to release -- attach() never took one (loadIdentityForFront's whole point), so a real bridge for this slot can already have claimed it by the time this runs. */
export async function detachFrontedSession(
  record: Readonly<Pick<FrontedRelayRecord, "agentId" | "store">>,
): Promise<void> {
  await record.store.setAgentOffline(record.agentId);
  await record.store.shutdown();
}

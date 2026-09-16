/**
 * cc-peer bridge — relays between one local Claude Code peer (reached via cc-peer's own native cross-session protocol) and this side's agent-comms mesh, giving that local session cross-machine reach through the mesh's own transport (agent-comms#87).
 *
 * One bridge process relays for exactly one target local Claude Code peer, matching the "one bridge process is one agent is one device" model every other bridge in this codebase already follows -- not a many-to-one fan-out. Inbound cc-peer messages from that target are posted into this agent's own project room (the same auto-created room ensureRegistered/ensureProjectRoom already gives every bridge); mesh deliveries for this agent are relayed back to that same target via CcPeer.send().
 *
 * The wiring itself (wireCcPeerBridge) is dependency-injected and deliberately separate from the real CcPeer/MeshStore construction in run.ts, so it can be tested against a fake CcPeer without a real local Claude Code session.
 */

import type { CommsTool } from "../../core/tool.js";
import { buildAction } from "../../core/bridge.js";
import { formatDeliveryEvent } from "../../core/bridge.js";
import type { DeliveryEvent } from "../../core/types.js";

/** How cc-peer addresses a target peer -- mirrors cc-peer's own PeerRef type without importing it, so this file has no direct dependency on the cc-peer package (only run.ts, which does the real construction, needs that). */
export type CcPeerRef =
  { pid: number } | { name: string } | { address: string };

/** The one inbound-message shape this bridge reads from CcPeer's own "message" event -- narrowed to the fields it actually uses. */
export interface CcPeerInboundMessage {
  from?: string;
  fromName?: string;
  body: string;
}

/** The narrow slice of CcPeer's own real API this bridge needs -- satisfied by the real class in run.ts, and by a fake in tests. */
export interface CcPeerLike {
  on: (
    event: "message",
    listener: (m: Readonly<CcPeerInboundMessage>) => void,
  ) => void;
  send: (
    target: Readonly<CcPeerRef>,
    body: string,
  ) => Promise<{ msgId: string }>;
}

/** The narrow slice of MeshStore this bridge needs -- onDelivery is MeshStore-only (not part of the generic CommsStore interface every bridge otherwise depends on), since only a mesh-backed store can push. */
export interface CcPeerBridgeStore {
  onDelivery:
    | ((agentId: string, event: DeliveryEvent) => void | Promise<void>)
    | undefined;
}

export interface CcPeerBridgeDeps {
  store: CcPeerBridgeStore;
  tool: Pick<CommsTool, "handle">;
  peer: CcPeerLike;
  agentId: string;
  roomId: string;
  target: Readonly<CcPeerRef>;
  cwd: string;
}

/** Wires the two directions of the relay. Never awaited by the caller -- both directions are genuinely fire-and-forget from this function's own point of view (a send failure surfaces through cc-peer's own receipt events / agent-comms' own delivery-status events, not a thrown error here). */
export function wireCcPeerBridge(deps: Readonly<CcPeerBridgeDeps>): void {
  deps.peer.on("message", (m) => {
    const sender = m.fromName ?? m.from ?? "unknown";
    const action = buildAction({
      action: "send",
      room: deps.roomId,
      content: `${sender}: ${m.body}`,
    });
    void deps.tool.handle(
      {
        agentId: deps.agentId,
        harness: "cc-peer",
        cwd: deps.cwd,
        pid: process.pid,
      },
      action,
    );
  });

  deps.store.onDelivery = (_targetId, event) => {
    void deps.peer.send(deps.target, formatDeliveryEvent(event));
  };
}

/**
 * cc-peer bridge — relays between one local Claude Code peer (reached via cc-peer's own native cross-session protocol) and this side's agent-comms mesh, giving that local session cross-machine reach through the mesh's own transport (agent-comms#87).
 *
 * One bridge process relays for exactly one target local Claude Code peer, matching the "one bridge process is one agent is one device" model every other bridge in this codebase already follows -- not a many-to-one fan-out. Inbound cc-peer messages from that target are posted into this agent's own project room (the same auto-created room ensureRegistered/ensureProjectRoom already gives every bridge); mesh deliveries for this agent are relayed back to that same target via CcPeer.send().
 *
 * The wiring itself (wireCcPeerBridge) is dependency-injected and deliberately separate from the real CcPeer/MeshStore construction in run.ts, so it can be tested against a fake CcPeer without a real local Claude Code session.
 */

import type { CommsTool } from "../../core/tool.js";
import { buildAction } from "../../core/bridge.js";
import {
  answerJoinRequest,
  formatCcPeerDelivery,
  parseApprovalCommand,
} from "./approval-commands.js";
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
  /** Where a failure relaying an inbound message is reported, since the relay is fire-and-forget from the cc-peer event's own point of view. */
  onError: ((error: Error) => void) | undefined;
}

/** The slice of a cc-peer roster entry needed to tell whether it is a given target. */
export interface CcPeerTargetEntry {
  pid: number;
  name?: string | undefined;
  messagingSocketPath: string;
}

/** Whether a roster entry is the session a target ref addresses. An address target names the session's own `uds:<socket path>` address. */
export function targetMatchesEntry(
  target: Readonly<CcPeerRef>,
  entry: Readonly<CcPeerTargetEntry>,
): boolean {
  if ("pid" in target) return entry.pid === target.pid;
  if ("name" in target) return entry.name === target.name;
  return target.address === `uds:${entry.messagingSocketPath}`;
}

/** Builds the predicate that says whether an inbound message was sent by the target session. The sender is identified by its `uds:<socket path>` address, resolved against a fresh roster read for every message so a target addressed by name is still recognised after that session restarts under a new pid. */
export function createTargetSenderMatcher(
  target: Readonly<CcPeerRef>,
  listRoster: () => Promise<readonly CcPeerTargetEntry[]>,
): (message: Readonly<CcPeerInboundMessage>) => Promise<boolean> {
  return async (message) => {
    if (message.from === undefined) return false;
    if ("address" in target) return message.from === target.address;
    const roster = await listRoster();
    const sender = roster.find(
      (entry) => `uds:${entry.messagingSocketPath}` === message.from,
    );
    return sender !== undefined && targetMatchesEntry(target, sender);
  };
}

export interface CcPeerBridgeDeps {
  store: CcPeerBridgeStore;
  tool: Pick<CommsTool, "handle">;
  peer: CcPeerLike;
  agentId: string;
  roomId: string;
  target: Readonly<CcPeerRef>;
  cwd: string;
  /** The name this bridge's peer is registered under, which the target is told to message to answer a join request. */
  peerName: string;
  /** Whether an inbound message was sent by the target session. Only those are posted into the project room: the peer may be shared with the default front, whose fronted sessions message it as well, and those belong to the front's own relay. */
  isFromTarget: (message: Readonly<CcPeerInboundMessage>) => Promise<boolean>;
}

/** Wires the two directions of the relay. Never awaited by the caller -- both directions are genuinely fire-and-forget from this function's own point of view (a send failure surfaces through cc-peer's own receipt events / agent-comms' own delivery-status events, not a thrown error here). */
export function wireCcPeerBridge(deps: Readonly<CcPeerBridgeDeps>): void {
  deps.peer.on("message", (m) => {
    void (async () => {
      if (!(await deps.isFromTarget(m))) return;
      const ctx = {
        agentId: deps.agentId,
        harness: "cc-peer",
        cwd: deps.cwd,
        pid: process.pid,
      };
      // A well-formed accept or reject is the target's decision on a waiting join request, not something to post into the project room.
      const decision = parseApprovalCommand(m.body);
      if (decision !== undefined) {
        const text = await answerJoinRequest(
          { tool: deps.tool, ctx },
          decision,
        );
        await deps.peer.send(deps.target, text);
        return;
      }
      const sender = m.fromName ?? m.from ?? "unknown";
      const action = buildAction({
        action: "send",
        room: deps.roomId,
        content: `${sender}: ${m.body}`,
      });
      await deps.tool.handle(ctx, action);
    })().catch((error: unknown) => {
      deps.store.onError?.(
        error instanceof Error ? error : new Error(String(error)),
      );
    });
  });

  deps.store.onDelivery = (_targetId, event) => {
    void deps.peer.send(
      deps.target,
      formatCcPeerDelivery(event, deps.peerName),
    );
  };
}

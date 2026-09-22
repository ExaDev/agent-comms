/**
 * Pure, DI-testable wiring for one fronted session's own cc-peer-to-mesh relay (agent-comms#157) -- the "attach"/"detach" half of the default front, building a FrontedSessionRecord (front-controller.ts) from an already-constructed mesh and the front's shared cc-peer peer. Mirrors bridges/cc-peer/bridge.ts's own wireCcPeerBridge split: kept free of any real CcPeer.create()/createBridgeMeshFromIdentity construction so it's testable against fakes, with front-runtime.ts supplying the real ones.
 *
 * Reuses CcPeerRef/CcPeerInboundMessage from bridge.ts rather than redeclaring them -- the wire shape a shared front-wide peer speaks is identical to the one-shot bridge command's own peer, just addressed by pid instead of a fixed target.
 */

import { buildAction } from "../../core/bridge.js";
import {
  answerJoinRequest,
  formatCcPeerDelivery,
  parseApprovalCommand,
} from "./approval-commands.js";
import type { CommsTool } from "../../core/tool.js";
import type { CommsAction, DeliveryEvent } from "../../core/types.js";
import { toError, type FrontedSessionRecord } from "./front-controller.js";
import type { CcPeerRosterEntryLike } from "./front.js";
import type { CcPeerInboundMessage, CcPeerRef } from "./bridge.js";
import { replyTargetForEvent, type ReplyContext } from "./reply-aliases.js";

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

/** The narrow slice of AliasPool (cc-peer's own cc-peer/alias-pool subpath) this relay needs: sending from the real OS-backed reply alias a correspondent's name was already minted for by FrontRelayAliasDirectory, which materialises that alias on the way. Narrowed so this module has no compile-time dependency on the cc-peer package itself, leaving front-runtime.ts to supply the real AliasPool. */
export interface FrontRelayAliasPool {
  send: (
    name: string,
    target: Readonly<CcPeerRef>,
    body: string,
  ) => Promise<{ msgId: string }>;
}

/** The narrow slice of ReplyAliasDirectory (reply-aliases.ts) this relay needs to mint/recall the alias name for one correspondent, and record its current reply context, on the mesh-to-session direction. */
export interface FrontRelayAliasDirectory {
  ensure: (correspondentId: string, context: ReplyContext) => string;
}

export interface FrontedRelayRecord extends FrontedSessionRecord {
  agentId: string;
  roomId: string;
  store: FrontRelayStore;
}

export interface BuildFrontedSessionRecordDeps {
  entry: Readonly<CcPeerRosterEntryLike>;
  /** The name the shared peer is registered under, which a session is told to message to answer a join request. */
  peerName: string;
  agentId: string;
  roomId: string;
  store: FrontRelayStore;
  tool: Pick<CommsTool, "handle">;
  peer: FrontRelayPeer;
  aliasPool: FrontRelayAliasPool;
  aliasDirectory: FrontRelayAliasDirectory;
  /** Where a relay failure this session cannot act on is reported: the front's own error channel (CcPeerFront's onError, ultimately the host bridge's store.onError), so a message that could not be delivered repliably is visible to the operator and not only to the session. */
  onError?: ((error: Error) => void) | undefined;
}

/**
 * Wires both relay directions for one fronted session and returns the record CcPeerFront tracks it under. Mesh-to-session: store.onDelivery sends the formatted event to this session's own pid. An event with a single originating correspondent (a dm or room_message, per replyTargetForEvent) is sent from that correspondent's own reply alias, so the sender the session sees, and therefore replies to, is the correspondent rather than the front (agent-comms#284); every other event, having no one repliable behind it, is sent from the front's shared peer. Session-to-mesh: the returned handleInbound (called by the front's shared "message" listener once it's matched this record by socket path) posts the message into this session's own project room, exactly as wireCcPeerBridge's own peer.on("message") handler does for the one-shot bridge command; handleAliasReply (called once CcPeerFront has resolved an inbound alias message to its correspondent and reply context) sends a mesh DM to that correspondent when the context is a dm, or posts back into the originating room when the context is a room — a reply to a room message no longer always becomes a private DM to its sender (agent-comms#289); notifyStaleAlias delivers a clear error back into the session for a reply on an alias the directory no longer recognises. All three mesh actions report a refusal back into the session rather than discarding it, so a reply the mesh would not carry is visible where it was written.
 */
export function buildFrontedSessionRecord(
  deps: Readonly<BuildFrontedSessionRecordDeps>,
): FrontedRelayRecord {
  const {
    entry,
    peerName,
    agentId,
    roomId,
    store,
    tool,
    peer,
    aliasPool,
    aliasDirectory,
    onError,
  } = deps;

  const ctx = {
    agentId,
    harness: "claude-code",
    cwd: entry.cwd,
    pid: process.pid,
  };

  const sendToSession = async (body: string): Promise<{ msgId: string }> =>
    peer.send({ pid: entry.pid }, body);

  /** Runs a mesh action as this session's own agent and relays a refusal back into the session. A relayed message the mesh refused is otherwise invisible from the session's side, so a reply that never left looks exactly like one that was delivered. */
  const runForSession = async (
    action: Readonly<CommsAction>,
    what: string,
  ): Promise<void> => {
    const outcome = await tool.handle(ctx, action);
    if (!outcome.isError) return;
    await sendToSession(`${what}: ${outcome.content}`);
  };

  store.onDelivery = async (_targetId, event) => {
    const body = formatCcPeerDelivery(event, peerName);
    const target = replyTargetForEvent(event);
    if (target === undefined) {
      await sendToSession(body);
      return;
    }
    const aliasName = aliasDirectory.ensure(
      target.correspondentId,
      target.context,
    );
    try {
      // Sent from the correspondent's own alias, not from the front's shared peer, so the session's native reply-to-sender lands on that alias and handleAliasReply routes it back to this correspondent's dm channel, or back into the room, per the alias's own recorded context. A hint naming the alias is deliberately not appended: the reply target is now the sender the session already replies to, and a model is free to ignore a hint (agent-comms#284).
      await aliasPool.send(aliasName, { pid: entry.pid }, body);
    } catch (error) {
      // Re-sending from the front's shared peer with a plain body would put the session back in exactly the failure this alias delivery exists to remove: its reply would reach the front, be posted into the project room, and never arrive. Deliver the content, say plainly that a reply cannot get back, and report the failure on the front's own error channel.
      onError?.(toError(error));
      await sendToSession(
        `${body}\n(Cannot reply: ${target.correspondentId}'s reply peer could not be started, so a reply to this message goes to this session's project room instead.)`,
      );
    }
  };

  return {
    pid: entry.pid,
    cwd: entry.cwd,
    messagingSocketPath: entry.messagingSocketPath,
    agentId,
    roomId,
    store,
    handleInbound: (message: Readonly<CcPeerInboundMessage>) => {
      // A well-formed accept or reject is the session's decision on a waiting join request, not something to post into the project room.
      const decision = parseApprovalCommand(message.body);
      if (decision !== undefined) {
        void answerJoinRequest({ tool, ctx }, decision).then(sendToSession);
        return;
      }
      const sender = message.fromName ?? message.from ?? "unknown";
      const action = buildAction({
        action: "send",
        room: roomId,
        content: `${sender}: ${message.body}`,
      });
      void runForSession(action, `Not posted to ${roomId}`);
    },
    handleAliasReply: (
      correspondentId: string,
      context: Readonly<ReplyContext>,
      message: Readonly<{ body: string }>,
    ) => {
      if (context.kind === "room") {
        const action = buildAction({
          action: "send",
          room: context.room,
          content: message.body,
        });
        void runForSession(action, `Reply to ${context.room} not delivered`);
        return;
      }
      const action = buildAction({
        action: "dm",
        target: correspondentId,
        content: message.body,
      });
      void runForSession(action, `Reply to ${correspondentId} not delivered`);
    },
    notifyStaleAlias: (aliasName: string) => {
      void sendToSession(
        `Reply not delivered: peer "${aliasName}" is no longer a known correspondent (reply aliases don't survive a front restart). Wait for a new message from them and reply to that instead.`,
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

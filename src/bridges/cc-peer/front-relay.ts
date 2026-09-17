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
import { correspondentForEvent } from "./reply-aliases.js";

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

/** The narrow slice of AliasPool (cc-peer's own cc-peer/alias-pool subpath) this relay needs -- materialising the real OS-backed reply alias a correspondent's name was already minted for by FrontRelayAliasDirectory. Narrowed so this module has no compile-time dependency on the cc-peer package itself -- front-runtime.ts supplies the real AliasPool. */
export interface FrontRelayAliasPool {
  ensure: (name: string) => Promise<void>;
}

/** The narrow slice of ReplyAliasDirectory (reply-aliases.ts) this relay needs to mint/recall the alias name for one correspondent on the mesh-to-session direction. */
export interface FrontRelayAliasDirectory {
  ensure: (correspondentId: string) => string;
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
  aliasPool: FrontRelayAliasPool;
  aliasDirectory: FrontRelayAliasDirectory;
}

/**
 * Wires both relay directions for one fronted session and returns the record CcPeerFront tracks it under. Mesh-to-session: store.onDelivery sends the formatted event to this session's own pid via the shared peer -- for an event with a single originating correspondent (a dm or room_message, per correspondentForEvent), it first materialises a reply alias for that correspondent and mentions it in the delivered body, so the session can address a reply to that specific correspondent the way it addresses any other local peer (agent-comms#158). Session-to-mesh: the returned handleInbound (called by the front's shared "message" listener once it's matched this record by socket path) posts the message into this session's own project room, exactly as wireCcPeerBridge's own peer.on("message") handler does for the one-shot bridge command; handleAliasReply (called once CcPeerFront has resolved an inbound alias message to its correspondent) instead sends a mesh DM to that correspondent, as this session's own agentId; notifyStaleAlias delivers a clear error back into the session for a reply on an alias the directory no longer recognises.
 */
export function buildFrontedSessionRecord(
  deps: Readonly<BuildFrontedSessionRecordDeps>,
): FrontedRelayRecord {
  const {
    entry,
    agentId,
    roomId,
    store,
    tool,
    peer,
    aliasPool,
    aliasDirectory,
  } = deps;

  store.onDelivery = async (_targetId, event) => {
    const body = formatDeliveryEvent(event);
    const correspondentId = correspondentForEvent(event);
    if (correspondentId === undefined) {
      await peer.send({ pid: entry.pid }, body);
      return;
    }
    const aliasName = aliasDirectory.ensure(correspondentId);
    try {
      await aliasPool.ensure(aliasName);
      await peer.send(
        { pid: entry.pid },
        `${body} (reply via peer "${aliasName}")`,
      );
    } catch {
      // The alias failed to materialise (e.g. the worker process failed to start) -- deliver the message anyway, just without a reply hint the session couldn't actually use.
      await peer.send({ pid: entry.pid }, body);
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
    handleAliasReply: (
      correspondentId: string,
      message: Readonly<{ body: string }>,
    ) => {
      const action = buildAction({
        action: "dm",
        target: correspondentId,
        content: message.body,
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
    notifyStaleAlias: (aliasName: string) => {
      void peer.send(
        { pid: entry.pid },
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

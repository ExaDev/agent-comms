/**
 * Integration coverage for the fronted cc-peer session's own reply-alias routing (agent-comms#289): a real MeshStore/CommsTool pair fronted by buildFrontedSessionRecord, wired to a real ReplyAliasDirectory rather than a stub, proving a reply to a room message posts back into the room it came from — not a DM to its sender — while a reply to a genuine DM still becomes a DM. Both paths share the same per-correspondent alias (reply-aliases.ts), so both need real coverage, not just the one that was broken.
 */

import { test, expect } from "vitest";
import { MeshStore } from "../core/mesh-store.js";
import { CommsTool } from "../core/tool.js";
import type { DeliveryEvent } from "../core/types.js";
import { buildFrontedSessionRecord } from "../bridges/cc-peer/front-relay.js";
import { ReplyAliasDirectory } from "../bridges/cc-peer/reply-aliases.js";
import { waitFor, wireTestTransport } from "./test-transport.js";

let nextPort = 27_500;
function freshPort(): number {
  nextPort += 1;
  return nextPort;
}

const PEER_NAME = "agent-comms-front";
const SESSION_PID = 4343;

async function registered(port: number, name: string): Promise<MeshStore> {
  const store = new MeshStore({ coordinatorPort: port });
  await wireTestTransport(store);
  await store.init();
  await store.registerAgent({
    name,
    harness: "test",
    cwd: `/test/${name}`,
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  return store;
}

/** Builds a fronted session record for `fronted`, backed by a real ReplyAliasDirectory, with a fake cc-peer peer/alias pool standing in for the session's own process — the same DI seam cc-peer-front-relay.unit.test.ts and cc-peer-fronted-approval.integration.test.ts already use, just with the real alias-context bookkeeping this test exists to exercise. */
function frontFor(
  fronted: MeshStore,
  cwd: string,
): {
  toSession: string[];
  toSessionFromAlias: { alias: string; body: string }[];
  aliasDirectory: ReplyAliasDirectory;
  record: ReturnType<typeof buildFrontedSessionRecord>;
} {
  const toSession: string[] = [];
  const toSessionFromAlias: { alias: string; body: string }[] = [];
  const aliasDirectory = new ReplyAliasDirectory();
  const record = buildFrontedSessionRecord({
    entry: {
      pid: SESSION_PID,
      cwd,
      version: "2.1.278",
      messagingSocketPath: "/tmp/cc-socks/fronted.sock",
    },
    peerName: PEER_NAME,
    agentId: fronted.peerId,
    roomId: "unused",
    store: fronted,
    tool: new CommsTool(fronted),
    peer: {
      send: async (_target, body) => {
        toSession.push(body);
        return Promise.resolve({ msgId: "m" });
      },
    },
    aliasPool: {
      send: async (alias, _target, body) => {
        toSessionFromAlias.push({ alias, body });
        return Promise.resolve({ msgId: "m" });
      },
    },
    aliasDirectory,
  });
  return { toSession, toSessionFromAlias, aliasDirectory, record };
}

test("a fronted session's reply to a room message posts back into that room, not a DM to its sender (agent-comms#289)", async () => {
  const port = freshPort();
  const sender = await registered(port, "room-sender");
  const fronted = await registered(port, "room-fronted");
  await waitFor(
    () => sender.serialise().agents[fronted.peerId] !== undefined,
    "the sender sees the fronted agent",
  );

  const room = await fronted.createRoom({
    name: "shared-room",
    type: "public",
    owner: fronted.peerId,
    description: "",
  });

  const joinPromise = sender.joinRoom(room.id, sender.peerId);
  await waitFor(
    () =>
      fronted
        .listPendingRoomJoins()
        .some((p) => p.roomPath === room.id && p.requesterId === sender.peerId),
    "the fronted agent to see the sender's pending join request",
  );
  fronted.acceptRoomJoin(room.id, sender.peerId);
  await joinPromise;

  const { toSessionFromAlias, aliasDirectory, record } = frontFor(
    fronted,
    "/test/room-fronted",
  );

  const senderDeliveries: DeliveryEvent[] = [];
  sender.onDelivery = (_agentId, event) => {
    senderDeliveries.push(event);
  };

  await sender.sendRoomMessage(room.id, sender.peerId, "hello from the room");

  await waitFor(
    () => toSessionFromAlias.length > 0,
    "the room message arrives at the fronted session from an alias",
  );
  const delivered = toSessionFromAlias[0];
  if (delivered === undefined) throw new Error("expected an alias delivery");
  expect(delivered.body).toContain("hello from the room");

  // Resolve the alias exactly as CcPeerFront.handleAliasMessage does: the correspondent and reply context the real directory recorded when this alias was minted/used, not a value this test invents.
  const correspondentId = aliasDirectory.correspondentFor(delivered.alias);
  const context = aliasDirectory.contextFor(delivered.alias);
  if (correspondentId === undefined || context === undefined) {
    throw new Error(
      "expected the alias to resolve to a correspondent and context",
    );
  }
  expect(context).toEqual({ kind: "room", room: room.id });

  senderDeliveries.length = 0;
  record.handleAliasReply(correspondentId, context, {
    body: "reply from the fronted session",
  });

  await waitFor(
    () =>
      senderDeliveries.some(
        (event) =>
          event.type === "room_message" &&
          event.message.content === "reply from the fronted session",
      ),
    "the sender receives the reply as a room message",
  );

  // Never delivered as a DM instead.
  expect(senderDeliveries.some((event) => event.type === "dm")).toBe(false);

  await fronted.shutdown();
  await sender.shutdown();
});

test("a fronted session's reply to a genuine DM still becomes a DM, through the same alias mechanism (agent-comms#289)", async () => {
  const port = freshPort();
  const sender = await registered(port, "dm-sender");
  const fronted = await registered(port, "dm-fronted");
  await waitFor(
    () => sender.serialise().agents[fronted.peerId] !== undefined,
    "the sender sees the fronted agent",
  );

  const { toSession, toSessionFromAlias, aliasDirectory, record } = frontFor(
    fronted,
    "/test/dm-fronted",
  );

  const dmAccessPromise = sender.requestDmAccess(fronted.peerId);
  await waitFor(
    () => toSession.some((body) => body.includes("accept ")),
    "the fronted session is told a dm request is waiting",
  );
  const instruction = toSession.find((body) => body.includes("accept "));
  const command = instruction
    ?.split("\n")
    .find((line) => line.startsWith("accept "));
  if (command === undefined) throw new Error("expected an accept command");
  record.handleInbound({
    from: `uds:${record.messagingSocketPath}`,
    body: command,
  });
  await dmAccessPromise;

  const senderDeliveries: DeliveryEvent[] = [];
  sender.onDelivery = (_agentId, event) => {
    senderDeliveries.push(event);
  };

  await sender.sendDm(sender.peerId, fronted.peerId, "hello session");

  await waitFor(
    () => toSessionFromAlias.length > 0,
    "the dm arrives at the fronted session from an alias",
  );
  const delivered = toSessionFromAlias[0];
  if (delivered === undefined) throw new Error("expected an alias delivery");
  expect(delivered.body).toContain("hello session");

  const correspondentId = aliasDirectory.correspondentFor(delivered.alias);
  const context = aliasDirectory.contextFor(delivered.alias);
  if (correspondentId === undefined || context === undefined) {
    throw new Error(
      "expected the alias to resolve to a correspondent and context",
    );
  }
  expect(context).toEqual({ kind: "dm" });
  expect(correspondentId).toBe(sender.peerId);

  record.handleAliasReply(correspondentId, context, {
    body: "reply as a real dm",
  });

  await waitFor(
    () =>
      senderDeliveries.some(
        (event) =>
          event.type === "dm" && event.message.content === "reply as a real dm",
      ),
    "the sender receives the reply as a dm",
  );

  await fronted.shutdown();
  await sender.shutdown();
});

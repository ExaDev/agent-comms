/**
 * Integration test for the whole first-contact path to a session reached only through cc-peer: a real store fronted by buildFrontedSessionRecord, a real CommsTool, and a fake cc-peer peer standing in for the session. The session is told what to send, sends it, and that alone admits the requester.
 */

import { test, expect } from "vitest";
import { MeshStore } from "../core/mesh-store.js";
import { CommsTool } from "../core/tool.js";
import { dmRoomPath } from "../core/room-path.js";
import { buildFrontedSessionRecord } from "../bridges/cc-peer/front-relay.js";
import { waitFor, wireTestTransport } from "./test-transport.js";

let nextPort = 24_450;
function freshPort(): number {
  nextPort += 1;
  return nextPort;
}

const PEER_NAME = "agent-comms-front";
const SESSION_PID = 4242;

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

test("a session with no agent-comms tool admits a first-contact DM by messaging the front, and hears the outcome", async () => {
  const port = freshPort();
  const sender = await registered(port, "sender");
  const fronted = await registered(port, "fronted");
  await waitFor(
    () => sender.serialise().agents[fronted.peerId] !== undefined,
    "the sender sees the fronted agent",
  );

  const toSession: string[] = [];
  const toSessionFromAlias: { alias: string; body: string }[] = [];
  const record = buildFrontedSessionRecord({
    entry: {
      pid: SESSION_PID,
      cwd: "/test/fronted",
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
    aliasDirectory: { ensure: (correspondent) => `mesh-${correspondent}` },
  });

  try {
    const dmPath = dmRoomPath(sender.peerId, fronted.peerId);
    const send = sender.sendDm(sender.peerId, fronted.peerId, "hello session");

    await waitFor(
      () => toSession.some((body) => body.includes("accept ")),
      "the session is told a request is waiting",
    );
    const instruction = toSession.find((body) => body.includes("accept "));
    const command = instruction
      ?.split("\n")
      .find((line) => line.startsWith("accept "));
    expect(command).toBe(`accept ${dmPath} ${sender.peerId}`);
    expect(instruction).toContain(`"${PEER_NAME}"`);

    // The session replies with exactly the line it was given.
    record.handleInbound({
      from: `uds:${record.messagingSocketPath}`,
      body: command ?? "",
    });

    const sent = await send;
    await waitFor(
      () =>
        (fronted.serialise().dms[dmPath] ?? []).some(
          (m) => m.id === sent.message.id,
        ),
      "the fronted agent receives the DM",
    );
    await waitFor(
      () => toSession.some((body) => body.startsWith("Accepted ")),
      "the session hears the outcome",
    );
    // The admitted DM reaches the session from the sender's own alias, never from the front, so the session's reply-to-sender goes back to the sender.
    await waitFor(
      () => toSessionFromAlias.length > 0,
      "the DM itself arrives from the sender's alias",
    );
    expect(toSessionFromAlias[0]?.alias).toBe(`mesh-${sender.peerId}`);
    expect(toSessionFromAlias[0]?.body).toContain("hello session");
    expect(toSession.some((body) => body.includes("hello session"))).toBe(
      false,
    );
  } finally {
    await fronted.shutdown();
    await sender.shutdown();
  }
});

test("a session that rejects a first-contact DM makes the sender's dm fail", async () => {
  const port = freshPort();
  const sender = await registered(port, "sender");
  const fronted = await registered(port, "fronted");
  await waitFor(
    () => sender.serialise().agents[fronted.peerId] !== undefined,
    "the sender sees the fronted agent",
  );

  const toSession: string[] = [];
  const toSessionFromAlias: { alias: string; body: string }[] = [];
  const record = buildFrontedSessionRecord({
    entry: {
      pid: SESSION_PID,
      cwd: "/test/fronted",
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
    aliasDirectory: { ensure: (correspondent) => `mesh-${correspondent}` },
  });

  try {
    const dmPath = dmRoomPath(sender.peerId, fronted.peerId);
    const send = sender.sendDm(sender.peerId, fronted.peerId, "unwelcome");
    const settled = expect(send).rejects.toThrow(/was refused \(denied\)/);

    await waitFor(
      () => toSession.some((body) => body.includes("reject ")),
      "the session is told a request is waiting",
    );
    record.handleInbound({
      body: `reject ${dmPath} ${sender.peerId} not now`,
    });

    await settled;
    await waitFor(
      () => toSession.some((body) => body.startsWith("Rejected ")),
      "the session hears the outcome",
    );
  } finally {
    await fronted.shutdown();
    await sender.shutdown();
  }
});

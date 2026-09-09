/**
 * Integration test for the WebSocket transport's broadcast queue: state patches broadcast before the WS data connections are established must be queued and flushed on registration, not dropped (#23).
 *
 * Mirrors broadcast-window.integration.test.ts over TlsTransport; the queue logic is implemented per transport, so each needs its own coverage.
 */

import * as assert from "node:assert/strict";
import { MeshStore } from "../core/mesh-store.js";
import { WebSocketTransport } from "../core/ws-transport.js";

const TEST_PORT = 19892;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A peer wired like a WS-based participant (browser relay worker). */
function makePeer(): MeshStore {
  const store = new MeshStore(TEST_PORT);
  store.setTransport(new WebSocketTransport(store.events));
  return store;
}

/** Poll until the predicate holds, or fail with the message. */
async function waitFor(
  what: string,
  check: () => Promise<boolean>,
): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (await check()) return;
    await sleep(100);
  }
  assert.ok(false, `timed out waiting for ${what}`);
}

async function main(): Promise<void> {
  // A is the coordinator and stays up throughout.
  const a = makePeer();
  await a.init();
  await a.registerAgent({
    name: "peer-a",
    harness: "user",
    cwd: "/test/a",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });

  // B joins and registers IMMEDIATELY after init() — no settle delay. This is exactly the pattern that used to race the dials and lose the upsert.
  const b = makePeer();
  await b.init();
  await b.registerAgent({
    name: "peer-b",
    harness: "user",
    cwd: "/test/b",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  const bId = b.peerId;

  await waitFor(
    "the coordinator to see the immediately-registered agent",
    async () => {
      const agents = await a.listAgents(a.peerId);
      const seen = agents.find((agent) => agent.id === bId);
      return seen?.status === "active";
    },
  );

  await waitFor("the joining peer to see the coordinator's agent", async () => {
    const agents = await b.listAgents(b.peerId);
    return agents.some((agent) => agent.id === a.peerId);
  });

  // A room message from the coordinator must push to the joiner over WS.
  await a.createRoom({
    name: "ws-window",
    type: "public",
    owner: a.peerId,
    description: "ws broadcast window",
  });
  await waitFor("the room to reach the joiner", async () => {
    const rooms = await b.listRooms(b.peerId);
    return rooms.some((room) => room.id === "ws-window");
  });
  await b.joinRoom("ws-window", b.peerId);
  // Wait for the membership to reach the sender before sending: delivery is
  // computed from the sender's local room state.
  await waitFor("the coordinator to see the joiner in the room", async () => {
    const room = await a.getRoom("ws-window");
    return room?.members.includes(bId) === true;
  });
  const deliveries: string[] = [];
  b.onDelivery = (_id, ev) => {
    if (ev.type === "room_message") deliveries.push(ev.message.content);
  };
  await a.sendRoomMessage("ws-window", a.peerId, "hello over ws");
  await waitFor("the WS room message push", async () =>
    deliveries.includes("hello over ws"),
  );

  await b.shutdown();
  await a.shutdown();
  console.log("✓ immediate registration and delivery work over WebSocket");
}

main().catch((err: unknown) => {
  console.error("Test failed:", err);
  process.exitCode = 1;
  // The sequence above keeps mesh handles open when it fails partway; exit explicitly so a failure cannot hang the runner.
  process.exit(1);
});

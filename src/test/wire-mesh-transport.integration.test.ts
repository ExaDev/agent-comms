/**
 * End-to-end parity test for WireMeshTransport, mirroring mesh-e2e.integration.test.ts's own scenario (coordinator discovery, room creation, messaging, delivery push) but against the new substrate instead of TlsTransport -- the concrete proof this phase's own charter ("semantics unchanged") holds for the core mesh-formation path, using waitFor polling rather than fixed sleeps for the same reason approval.integration.test.ts already does.
 */

import * as assert from "node:assert/strict";
import { test } from "node:test";
import { MeshStore } from "../core/mesh-store.js";
import { CommsTool } from "../core/tool.js";
import { buildAction } from "../core/bridge.js";
import type { DeliveryEvent } from "../core/types.js";
import { waitFor, wireWireMeshTestTransport } from "./test-transport.js";

async function createStore(
  port: number,
  name: string,
  harness: string,
): Promise<{ store: MeshStore; tool: CommsTool; deliveries: DeliveryEvent[] }> {
  const store = new MeshStore(port);
  wireWireMeshTestTransport(store);

  const deliveries: DeliveryEvent[] = [];
  store.onDelivery = (_agentId, event) => {
    deliveries.push(event);
  };

  const tool = new CommsTool(store);

  await store.init();
  await store.registerAgent({
    name,
    harness,
    cwd: `/test/${name}`,
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });

  return { store, tool, deliveries };
}

void test("WireMeshTransport: coordinator discovery, rooms, messaging, and delivery match TlsTransport's own semantics", async () => {
  const port = 20_000 + Math.floor(Math.random() * 1000);
  const a = await createStore(port, "peer-a", "test-a");
  let b: Awaited<ReturnType<typeof createStore>> | undefined;

  try {
    b = await createStore(port, "peer-b", "test-b");

    await waitFor(
      () => a.store.serialise().agents[b?.store.peerId ?? ""] !== undefined,
      "A sees B's agent",
    );
    await waitFor(
      () => b?.store.serialise().agents[a.store.peerId] !== undefined,
      "B sees A's agent",
    );

    const agentsA = await a.store.listAgents(a.store.peerId);
    const agentsB = await b.store.listAgents(b.store.peerId);
    assert.ok(agentsA.length >= 2, "A should see both agents");
    assert.ok(agentsB.length >= 2, "B should see both agents");

    const roomId = `test-room-${String(Date.now())}`;
    const room = await a.store.createRoom({
      name: roomId,
      type: "public",
      owner: a.store.peerId,
      description: "Test room",
    });

    await waitFor(
      () => b?.store.serialise().rooms[room.id] !== undefined,
      "B sees the room",
    );
    await b.store.joinRoom(room.id, b.store.peerId);

    await waitFor(
      () => a.store.serialise().rooms[room.id]?.members.length === 2,
      "A sees B join the room",
    );
    const roomA = await a.store.getRoom(room.id);
    const roomB = await b.store.getRoom(room.id);
    assert.strictEqual(roomA?.members.length, 2, "A should see 2 room members");
    assert.strictEqual(roomB?.members.length, 2, "B should see 2 room members");

    b.deliveries.length = 0;
    await a.store.sendRoomMessage(room.id, a.store.peerId, "Hello from A!");
    await waitFor(
      () => b?.deliveries.length !== 0,
      "B receives the room message",
    );
    const roomMsg = b.deliveries[0];
    assert.ok(roomMsg);
    assert.strictEqual(roomMsg.type, "room_message");
    assert.strictEqual(roomMsg.message.content, "Hello from A!");

    b.deliveries.length = 0;
    await a.store.sendDm(a.store.peerId, b.store.peerId, "Hey B!");
    await waitFor(() => b?.deliveries.length !== 0, "B receives the DM");
    const dmEvent = b.deliveries[0];
    assert.ok(dmEvent);
    assert.strictEqual(dmEvent.type, "dm");

    const messages = await b.store.readRoomMessages(room.id);
    assert.ok(messages.length >= 1, "B should see the message");

    a.deliveries.length = 0;
    const action = buildAction({
      action: "send",
      target: room.id,
      content: "Hello from B via tool!",
    });
    await b.tool.handle(
      {
        agentId: b.store.peerId,
        harness: "test-b",
        cwd: "/test/peer-b",
        pid: process.pid,
      },
      action,
    );
    await waitFor(
      () => a.deliveries.length !== 0,
      "A receives B's tool-sent message",
    );
  } finally {
    await b?.store.shutdown();
    await a.store.shutdown();
  }
});

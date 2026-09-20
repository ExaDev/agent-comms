/**
 * Integration test for the first DM to a counterpart: sendDm itself runs the requester half of the DM consent flow (section 6) when this device holds no room:member token for the pair's dm path yet, so a caller with only a target id (the `dm` tool action) never has to know requestDmAccess exists.
 */

import { test, expect } from "vitest";
import { MeshStore } from "../core/mesh-store.js";
import type { DeliveryEvent } from "../core/types.js";
import { dmRoomPath } from "../core/room-path.js";
import { waitFor, wireTestTransport } from "./test-transport.js";

let nextPort = 21_950;
function freshPort(): number {
  nextPort += 1;
  return nextPort;
}

async function makeConnectedPair(
  port: number,
): Promise<{ a: MeshStore; b: MeshStore }> {
  const a = new MeshStore({ coordinatorPort: port });
  await wireTestTransport(a);
  await a.init();
  await a.registerAgent({
    name: "a",
    harness: "test",
    cwd: "/test/a",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });

  const b = new MeshStore({ coordinatorPort: port });
  await wireTestTransport(b);
  await b.init();
  await b.registerAgent({
    name: "b",
    harness: "test",
    cwd: "/test/b",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });

  await waitFor(
    () => a.serialise().agents[b.peerId] !== undefined,
    "a sees b's agent",
  );
  return { a, b };
}

test("a first sendDm holds for the counterpart's decision, delivers once accepted, and needs no second decision for later messages or the reply", async () => {
  const { a, b } = await makeConnectedPair(freshPort());

  try {
    const dmPath = dmRoomPath(a.peerId, b.peerId);

    const firstSend = a.sendDm(a.peerId, b.peerId, "first");
    await waitFor(
      () => b.listPendingRoomJoins().length === 1,
      "b sees a's pending DM request",
    );
    expect(b.listPendingRoomJoins()).toEqual([
      { roomPath: dmPath, requesterId: a.peerId },
    ]);
    // Nothing is recorded as sent while the request is still undecided.
    expect(a.serialise().dms[dmPath]).toBeUndefined();

    b.acceptRoomJoin(dmPath, a.peerId);
    const first = await firstSend;

    await waitFor(
      () =>
        (b.serialise().dms[dmPath] ?? []).some(
          (m) => m.id === first.message.id,
        ),
      "b receives the first DM",
    );

    const second = await a.sendDm(a.peerId, b.peerId, "second");
    await waitFor(
      () =>
        (b.serialise().dms[dmPath] ?? []).some(
          (m) => m.id === second.message.id,
        ),
      "b receives the second DM",
    );
    expect(b.listPendingRoomJoins()).toEqual([]);

    // b's reply asks a for access in the other direction; a's own outbound request already covers it.
    const reply = await b.sendDm(b.peerId, a.peerId, "reply");
    await waitFor(
      () =>
        (a.serialise().dms[dmPath] ?? []).some(
          (m) => m.id === reply.message.id,
        ),
      "a receives b's reply",
    );
    expect(a.listPendingRoomJoins()).toEqual([]);
  } finally {
    await b.shutdown();
    await a.shutdown();
  }
});

test("a first sendDm the counterpart rejects throws and leaves no message recorded", async () => {
  const { a, b } = await makeConnectedPair(freshPort());

  try {
    const dmPath = dmRoomPath(a.peerId, b.peerId);

    const send = a.sendDm(a.peerId, b.peerId, "unwelcome");
    const settled = expect(send).rejects.toThrow(/was refused \(denied\)/);
    await waitFor(
      () => b.listPendingRoomJoins().length === 1,
      "b sees a's pending DM request",
    );
    b.rejectRoomJoin(dmPath, a.peerId, "not interested");
    await settled;

    expect(a.serialise().dms[dmPath]).toBeUndefined();
    expect(b.serialise().dms[dmPath]).toBeUndefined();
  } finally {
    await b.shutdown();
    await a.shutdown();
  }
});

test("the counterpart's agent is told about a pending DM request, so it knows there is something to accept", async () => {
  const { a, b } = await makeConnectedPair(freshPort());

  try {
    const dmPath = dmRoomPath(a.peerId, b.peerId);
    const seen: DeliveryEvent[] = [];
    b.onDelivery = (_agentId, event) => {
      seen.push(event);
    };

    const send = a.sendDm(a.peerId, b.peerId, "hello");
    await waitFor(
      () => seen.some((e) => e.type === "room_join_request"),
      "b is told about a's pending DM request",
    );
    expect(seen.filter((e) => e.type === "room_join_request")).toEqual([
      { type: "room_join_request", room: dmPath, requesterId: a.peerId },
    ]);

    b.acceptRoomJoin(dmPath, a.peerId);
    await send;
  } finally {
    await b.shutdown();
    await a.shutdown();
  }
});

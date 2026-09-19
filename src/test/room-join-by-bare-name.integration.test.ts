/**
 * agent-comms#246 -- list_rooms shows a room hosted by another device by its bare name, so join_room must accept that same bare name, not only the full `<hostDevice>/<name>` room-path. Over a real relay hub the joiner has never received the host's room through any legacy full-state-sync, so the only thing that tells it the room exists is the host's gossiped hosted-room advert: exactly the discovery source list_rooms itself reads, and therefore the one a bare name has to resolve against.
 */

import { afterEach, describe, expect, it } from "vitest";
import { MeshStore } from "../core/mesh-store.js";
import { CommsTool } from "../core/tool.js";
import { buildAction } from "../core/bridge.js";
import { wireTestTransportWithHub } from "./test-transport.js";
import { realHubOverWs, waitForCondition } from "./hub-helpers.js";

const GOSSIP_INTERVAL_MS = 100;
const POLL_INTERVAL_MS = 25;
const DISCOVERY_TIMEOUT_MS = 10_000;

interface ToolContext {
  agentId: string;
  harness: string;
  cwd: string;
  pid: number;
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanups.splice(0)) {
    await close();
  }
});

/** Polls an async condition until it holds. hub-helpers' waitForCondition only accepts a synchronous predicate, and listRooms is async. */
async function eventually(condition: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + DISCOVERY_TIMEOUT_MS;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error("condition not met within timeout");
    }
    await new Promise((resolve) => {
      setTimeout(resolve, POLL_INTERVAL_MS);
    });
  }
}

/** Wires a MeshStore onto the hub at hubUrl with a short gossip cadence, so a room it hosts is advertised to the other hub peers quickly. Never calls MeshStore.init(): hub mode has no local-mesh coordinator election, and calling it would risk colliding with an unrelated coordinator on the well-known port. */
async function connectedStore(
  hubUrl: string,
  name: string,
): Promise<{ store: MeshStore; ctx: ToolContext }> {
  const store = new MeshStore();
  const { transport } = await wireTestTransportWithHub(store, {
    presenceReadvertiseIntervalMs: GOSSIP_INTERVAL_MS,
  });
  await store.registerAgent({
    name,
    harness: "test",
    cwd: `/test/${name}`,
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  await transport.connectHub?.(hubUrl);
  await waitForCondition(() => transport.hub.isConnected);
  return {
    store,
    ctx: {
      agentId: store.peerId,
      harness: "test",
      cwd: `/test/${name}`,
      pid: process.pid,
    },
  };
}

/** A hub peer only broadcasts its own adverts onto the hub once it trusts at least one other hub device (GatewayTrust's hasAny gate), so every store in these tests trusts every other one. */
function trustEachOther(stores: readonly MeshStore[]): void {
  for (const store of stores) {
    for (const other of stores) {
      if (other !== store) store.gatewayTrust.add(other.peerId);
    }
  }
}

describe("addressing a gossip-discovered room by the bare name list_rooms shows", () => {
  it("join_room resolves the bare name to the hosting device's room-path and joins it", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);
    const owner = await connectedStore(hub.url, "owner");
    const requester = await connectedStore(hub.url, "requester");
    trustEachOther([owner.store, requester.store]);

    const room = await owner.store.createRoom({
      name: "e2e-test",
      type: "public",
      owner: owner.store.peerId,
      description: "",
    });
    expect(await requester.store.getRoom(room.id)).toBeUndefined();
    await eventually(async () =>
      (await requester.store.listRooms(requester.store.peerId)).some(
        (listed) => listed.name === "e2e-test",
      ),
    );

    const tool = new CommsTool(requester.store);
    const joinResult = tool.handle(
      requester.ctx,
      buildAction({ action: "join_room", room: "e2e-test" }),
    );
    await waitForCondition(() =>
      owner.store
        .listPendingRoomJoins()
        .some((pending) => pending.roomPath === room.id),
    );
    owner.store.acceptRoomJoin(room.id, requester.store.peerId);

    const result = await joinResult;
    expect(result.isError).toBe(false);
    expect(result.content).not.toContain("not a valid room-path");
    const joined = await requester.store.getRoom(room.id);
    expect(joined?.members).toContain(requester.store.peerId);

    await requester.store.shutdown();
    await owner.store.shutdown();
  });

  it("refuses to pick between two hosts advertising the same room name, naming both candidates", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);
    const first = await connectedStore(hub.url, "first");
    const second = await connectedStore(hub.url, "second");
    const requester = await connectedStore(hub.url, "requester");
    trustEachOther([first.store, second.store, requester.store]);

    const firstRoom = await first.store.createRoom({
      name: "e2e-test",
      type: "public",
      owner: first.store.peerId,
      description: "",
    });
    const secondRoom = await second.store.createRoom({
      name: "e2e-test",
      type: "public",
      owner: second.store.peerId,
      description: "",
    });
    await eventually(async () => {
      const rooms = await requester.store.listRooms(requester.store.peerId);
      return (
        rooms.some((listed) => listed.id === firstRoom.id) &&
        rooms.some((listed) => listed.id === secondRoom.id)
      );
    });

    const tool = new CommsTool(requester.store);
    const result = await tool.handle(
      requester.ctx,
      buildAction({ action: "join_room", room: "e2e-test" }),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("AMBIGUOUS_ROOM_NAME");
    expect(result.content).toContain(firstRoom.id);
    expect(result.content).toContain(secondRoom.id);

    await requester.store.shutdown();
    await second.store.shutdown();
    await first.store.shutdown();
  });
});

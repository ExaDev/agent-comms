/**
 * Integration tests for the server's oRPC router on /ws/mesh.
 *
 * Drives every procedure through a real oRPC client over a real WebSocket connection against a real running server -- not a mocked transport -- including a resume/lastEventId replay test proving subscribeEvents actually closes the gap the plan set out to close: an event published while a subscriber is disconnected is still delivered once it reconnects with its last-received event id.
 */

import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import WsWebSocket from "ws";
import { createORPCClient, getEventMeta } from "@orpc/client";
import { RPCLink, type WebSocketLike } from "@orpc/client/websocket";
import type { ContractRouterClient } from "@orpc/contract";
import { createWebServer, type WebServerHandle } from "../server.js";
import type { meshContract, MeshEvent } from "../contract.js";
import { unreachableHubUrl } from "../../../../test/hub-helpers.js";

type MeshClient = ContractRouterClient<typeof meshContract>;

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
    server.on("error", reject);
  });
}

const sockets: WsWebSocket[] = [];
let handle: WebServerHandle | undefined;

/**
 * Connects a fresh oRPC client to a real running server's /ws/mesh endpoint over a real WebSocket -- not a mock. "ws"'s own WebSocket type declarations don't structurally satisfy WebSocketLike (its addEventListener options param is narrower than DOM's, an upstream typing gap between "ws" and the browser lib oRPC's client targets, not a real capability gap -- "ws" does implement addEventListener/removeEventListener/send/readyState). The cast below is the single, contained boundary point for that gap.
 */
function connectMeshClient(port: number): MeshClient {
  const link = new RPCLink({
    connect: async () => {
      const socket = new WsWebSocket(`ws://127.0.0.1:${String(port)}/ws/mesh`);
      sockets.push(socket);
      return new Promise<WebSocketLike>((resolve, reject) => {
        socket.once("open", () => {
          resolve(socket as unknown as WebSocketLike);
        });
        socket.once("error", reject);
      });
    },
  });
  return createORPCClient(link);
}

async function setup(): Promise<{ client: MeshClient; port: number }> {
  const coordinatorPort = await findFreePort();
  const hubUrl = await unreachableHubUrl();
  handle = await createWebServer({ coordinatorPort, hubUrl });
  await new Promise<void>((resolve) => {
    if (handle?.server.listening === true) {
      resolve();
      return;
    }
    handle?.server.once("listening", () => {
      resolve();
    });
  });
  const addr = handle.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { client: connectMeshClient(port), port };
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  if (handle) {
    // wss.close()/server.close() are asynchronous -- neither actually releases its port until its optional callback fires. Awaiting that here keeps a later test's findFreePort() from being handed a port this handle hasn't genuinely released yet.
    await new Promise<void>((resolve) => {
      handle?.wss.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      handle?.server.close(() => resolve());
    });
    await handle.controller.shutdown();
    handle = undefined;
  }
});

/**
 * ContractRouterClient's inferred subscribeEvents() return type doesn't propagate MeshEvent through eventIterator()'s generic inference at this beta version (confirmed by direct inspection: every yielded value types as `{}`, not the discriminated union). Both helpers below are the single, contained boundary casting the real runtime shape (a genuine AsyncIterator yielding MeshEvent, which is exactly what the server-side handler and the contract's eventIterator(MeshEventSchema) output schema both guarantee) back to a usable type -- nothing downstream of these two functions needs its own cast.
 */
function toMeshIterator(value: unknown): AsyncIterator<MeshEvent> {
  return value as AsyncIterator<MeshEvent>;
}

async function nextMeshEvent(
  iterator: Readonly<AsyncIterator<MeshEvent>>,
): Promise<MeshEvent | undefined> {
  const result = await iterator.next();
  return result.done === true ? undefined : result.value;
}

/** A device-id is a hex-encoded SHA-256 hash: 32 bytes, 64 hex characters. */
const DEVICE_ID_HEX_LENGTH = 64;
const DRAIN_IDLE_MS = 300;
/** Generous upper bound on events to poll through before giving up on finding a specific expected event -- each attempt blocks on a real event arriving, so this bounds worst-case test runtime, not a count tied to any specific number of patches a given action produces. */
const MAX_POLL_ATTEMPTS = 20;

/**
 * A single mutating action (e.g. createRoom, which the mesh store's own auto-join broadcasts a room_upsert, an agent_upsert, and a second room_upsert for -- three separate state_patch events from one call) can publish more than one event. Draining until no new event arrives for DRAIN_IDLE_MS, rather than reading exactly one, is what makes "the last event id this action produced" a genuine baseline to resume from -- reading only the first event of a multi-patch action would leave its own later patches still ahead of that id, and they'd legitimately (correctly) replay on resume, which is not what "this room was fully handled before disconnecting" is meant to test.
 */
async function drainSettledEvents(
  iterator: Readonly<AsyncIterator<MeshEvent>>,
): Promise<MeshEvent[]> {
  const events: MeshEvent[] = [];
  for (;;) {
    const idle = Symbol("idle");
    const next = await Promise.race([
      nextMeshEvent(iterator),
      new Promise<typeof idle>((resolve) => {
        setTimeout(() => {
          resolve(idle);
        }, DRAIN_IDLE_MS);
      }),
    ]);
    if (next === idle) return events;
    if (next === undefined) return events;
    events.push(next);
  }
}

/** A room's real id is an owner-scoped path ("<device-id>/<slug>"), not its bare name -- createRoomAction's own success message is `Created <type> room "<name>" (<id>).`, the same string the CLI/legacy UI already parse for this. `send`'s target must be the real id; `joinRoom`/`switchRoom` accept either. */
function extractRoomId(createRoomContent: string): string {
  const match = /\(([^)]+)\)\.$/.exec(createRoomContent);
  const id = match?.[1];
  if (id === undefined || id === "") {
    throw new Error(`could not extract room id from: ${createRoomContent}`);
  }
  return id;
}

describe("oRPC router over /ws/mesh", () => {
  it("listRooms responds through a real websocket round trip", async () => {
    const { client } = await setup();
    const result = await client.listRooms({});
    expect(result.isError).toBe(false);
  });

  it("createRoom then joinRoom then listRooms reflects the new room", async () => {
    const { client } = await setup();
    const created = await client.createRoom({
      name: "orpc-test-room",
      type: "public",
    });
    expect(created.isError).toBe(false);

    const joined = await client.joinRoom({ room: "orpc-test-room" });
    expect(joined.isError).toBe(false);

    const rooms = await client.listRooms({});
    expect(rooms.content).toContain("orpc-test-room");
  });

  it("send validates missing target/content the same way the legacy REST path does", async () => {
    const { client } = await setup();
    const result = await client.send({ target: "", content: "" });
    expect(result.isError).toBe(true);
    expect(result.content).toBe("Missing target or content");
  });

  it("subscribeEvents yields an initial state_sync when called fresh", async () => {
    const { client } = await setup();
    const iterator = toMeshIterator(await client.subscribeEvents({}));
    const first = await nextMeshEvent(iterator);
    expect(first?.kind).toBe("state_sync");
    await iterator.return?.(undefined);
  });

  // sendRoomMessage's own fan-out explicitly excludes the sender (room-messaging.ts: `if (memberId !== from)`) -- a single-peer test sending to a room it's the only member of never produces a "delivery" MeshEvent for itself, matching how the legacy UI already shows a sender's own message (a REST refetch after the action result, not a delivery push). createRoom is used instead as the triggering event below: RoomLifecycle.createRoom broadcasts a real room_upsert patch through the identical store.onPatch -> MeshEventPublisher pipeline delivery events use, so it proves the same publish/subscribe/resume mechanism without depending on multi-peer fan-out semantics this PR isn't testing.
  it("subscribeEvents delivers a state_patch published after subscribing", async () => {
    const { client } = await setup();

    const iterator = toMeshIterator(await client.subscribeEvents({}));
    await nextMeshEvent(iterator); // state_sync

    const createResult = client.createRoom({
      name: "live-room",
      type: "public",
    });

    let sawPatch = false;
    for (let i = 0; i < MAX_POLL_ATTEMPTS && !sawPatch; i++) {
      const event = await nextMeshEvent(iterator);
      if (
        event?.kind === "state_patch" &&
        event.patch.type === "room_upsert" &&
        event.patch.room.name === "live-room"
      ) {
        sawPatch = true;
      }
    }
    expect(sawPatch).toBe(true);
    await createResult;
    await iterator.return?.(undefined);
  });

  it("resumes a subscribeEvents stream by lastEventId after disconnecting", async () => {
    const { client, port } = await setup();

    const iterator = toMeshIterator(await client.subscribeEvents({}));
    const sync = await nextMeshEvent(iterator);
    expect(sync?.kind).toBe("state_sync");

    // Publish one event while still subscribed, and capture the real event id the publisher assigned its LAST resulting patch via getEventMeta -- state_sync itself was never published through the publisher's buffer (it's synthesised fresh per connection), so it carries no id to resume from. This id is the genuine baseline a reconnecting tab resumes from, matching what oRPC's own RetryLinkPlugin would track.
    const beforeDisconnect = await client.createRoom({
      name: "before-disconnect-room",
      type: "public",
    });
    expect(beforeDisconnect.isError).toBe(false);
    const beforeDisconnectEvents = await drainSettledEvents(iterator);
    expect(beforeDisconnectEvents.length).toBeGreaterThan(0);
    const lastBeforeDisconnectEvent =
      beforeDisconnectEvents[beforeDisconnectEvents.length - 1];
    const lastEventId =
      lastBeforeDisconnectEvent !== undefined
        ? getEventMeta(lastBeforeDisconnectEvent)?.id
        : undefined;
    expect(lastEventId).toBeDefined();

    // Disconnect the subscriber (simulating a tab going away) without consuming any further events from this iterator.
    await iterator.return?.(undefined);

    // Publish a second event while nobody is subscribed.
    const result = await client.createRoom({
      name: "after-disconnect-room",
      type: "public",
    });
    expect(result.isError).toBe(false);

    // Reconnect fresh (a new client, matching a real reconnecting tab) and resume from the id captured above -- proving the publisher replays only what was missed, not the whole buffer from the start.
    const resumeClient = connectMeshClient(port);
    const resumed = toMeshIterator(
      await resumeClient.subscribeEvents({ lastEventId }),
    );

    let replayed = false;
    const replayedRoomNames: string[] = [];
    for (let i = 0; i < MAX_POLL_ATTEMPTS && !replayed; i++) {
      const event = await nextMeshEvent(resumed);
      if (event?.kind === "state_patch" && event.patch.type === "room_upsert") {
        replayedRoomNames.push(event.patch.room.name);
        if (event.patch.room.name === "after-disconnect-room") {
          replayed = true;
        }
      }
    }
    expect(replayed).toBe(true);
    // Proves genuine offset-based resume, not "replay the whole buffer": the room created before disconnecting was already consumed by the original iterator, so it must not come through again here.
    expect(replayedRoomNames).not.toContain("before-disconnect-room");
    await resumed.return?.(undefined);
  });

  it("getRoomMessages returns a sent message's structured history, not an ActionResult", async () => {
    const { client } = await setup();
    const created = await client.createRoom({
      name: "get-room-messages-room",
      type: "public",
    });
    expect(created.isError).toBe(false);
    const roomId = extractRoomId(created.content);

    const sent = await client.send({ target: roomId, content: "hello there" });
    expect(sent.isError).toBe(false);

    const messages = await client.getRoomMessages({ room: roomId });
    expect(messages.some((m) => m.content === "hello there")).toBe(true);
  });

  it("getMeshGraph returns structured nodes/edges", async () => {
    const { client } = await setup();
    const graph = await client.getMeshGraph({});
    expect(Array.isArray(graph.nodes)).toBe(true);
    expect(Array.isArray(graph.edges)).toBe(true);
  });

  it("getMeshTrace returns a structured not_connected outcome for an unreachable target", async () => {
    const { client } = await setup();
    const result = await client.getMeshTrace({
      target: "0".repeat(DEVICE_ID_HEX_LENGTH),
    });
    expect(result.outcome.result).toBe("error");
    expect(result.outcome.code).toBe("not_connected");
  });
});

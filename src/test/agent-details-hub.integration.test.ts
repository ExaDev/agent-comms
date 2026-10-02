import { afterEach, expect, it } from "vitest";
import {
  realHubOverWs,
  TeardownStack,
  waitForCondition,
} from "./hub-helpers.js";
import { waitFor, wireTestTransportWithHub } from "./test-transport.js";
import { MeshStore } from "../core/mesh-store.js";

/** Covers the hub handshake and the first end-to-end secure channel setup on a loaded machine. */
const HUB_CONNECT_TIMEOUT_MS = 15_000;
/** Covers the same setup plus one request round trip each way. */
const DETAILS_EXCHANGE_TIMEOUT_MS = 25_000;

const cleanups = new TeardownStack();
afterEach(async () => {
  await cleanups.run();
});

it("two stores exchange agent details through a real relay hub", async () => {
  const hub = await realHubOverWs();
  cleanups.push(hub.close);
  const answerer = new MeshStore();
  const { transport: answererTransport } =
    await wireTestTransportWithHub(answerer);
  await answerer.registerAgent({
    name: "answerer",
    harness: "test",
    cwd: "/t/a",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  const asker = new MeshStore();
  const { transport: askerTransport } = await wireTestTransportWithHub(asker);
  await asker.registerAgent({
    name: "asker",
    harness: "test",
    cwd: "/t/b",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  asker.gatewayTrust.add(answerer.peerId);
  answerer.gatewayTrust.add(asker.peerId);
  cleanups.push(async () => answerer.shutdown());
  cleanups.push(async () => asker.shutdown());
  await answererTransport.hub.connect(hub.url);
  await askerTransport.hub.connect(hub.url);
  await waitForCondition(
    () =>
      askerTransport.hub.isConnected &&
      askerTransport.hub.peers().includes(answerer.peerId),
    HUB_CONNECT_TIMEOUT_MS,
  );
  const stub = (id: string, name: string) => ({
    id,
    version: 1,
    name,
    harness: "test",
    cwd: "",
    pid: process.pid,
    startedAt: new Date().toISOString(),
    visibility: "visible" as const,
    status: "active" as const,
    tags: [],
    subscribedRooms: [],
  });
  asker.agentDetailsExchange.refresh(
    [stub(answerer.peerId, "answerer")],
    asker.peerId,
  );
  answerer.agentDetailsExchange.refresh(
    [stub(asker.peerId, "asker")],
    answerer.peerId,
  );
  await waitFor(
    () =>
      asker.agentDetailsExchange.cached(answerer.peerId) !== undefined &&
      answerer.agentDetailsExchange.cached(asker.peerId) !== undefined,
    "both stores cached the other's agent details",
    DETAILS_EXCHANGE_TIMEOUT_MS,
  );
  expect(asker.agentDetailsExchange.cached(answerer.peerId)?.cwd).toBe("/t/a");
  expect(answerer.agentDetailsExchange.cached(asker.peerId)?.cwd).toBe("/t/b");
});

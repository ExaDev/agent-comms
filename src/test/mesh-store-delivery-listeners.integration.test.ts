/**
 * MeshStore.addDeliveryListener (agent-comms#293): several parties share one store's delivery events, a bridge's own onDelivery handler and the web UI it serves, so serving the UI does not need a second store and neither party can silence the other by assigning last.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MeshStore } from "../core/mesh-store.js";
import type { DeliveryEvent } from "../core/types.js";
import { TeardownStack } from "./hub-helpers.js";
import { wireTestTransport } from "./test-transport.js";

let nextPort = 23_800;
function freshPort(): number {
  nextPort += 1;
  return nextPort;
}

const cleanups = new TeardownStack();

afterEach(async () => {
  await cleanups.run();
});

async function startStore(): Promise<MeshStore> {
  const store = new MeshStore({ coordinatorPort: freshPort() });
  await wireTestTransport(store);
  await store.init();
  cleanups.push(async () => store.shutdown());
  await store.registerAgent({
    name: "listener-test",
    harness: "test",
    cwd: "/test/listeners",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  return store;
}

let nextMessage = 0;
/** A room message that is new to the store every time, so the delivery engine's own de-duplication never swallows it. */
function freshEvent(): DeliveryEvent {
  nextMessage += 1;
  return {
    type: "room_message",
    message: {
      id: `message-${String(nextMessage)}`,
      from: "someone",
      room: "room",
      content: `hello ${String(nextMessage)}`,
      timestamp: "2026-01-01T00:00:00.000Z",
      readBy: [],
    },
  };
}

describe("MeshStore.addDeliveryListener", () => {
  it("gives an event to onDelivery and to every listener", async () => {
    const store = await startStore();
    const handler = vi.fn();
    const first = vi.fn();
    const second = vi.fn();
    store.onDelivery = handler;
    store.addDeliveryListener(first);
    store.addDeliveryListener(second);
    const event = freshEvent();

    await store.deliver(store.peerId, event);

    expect(handler).toHaveBeenCalledWith(store.peerId, event);
    expect(first).toHaveBeenCalledWith(store.peerId, event);
    expect(second).toHaveBeenCalledWith(store.peerId, event);
  });

  it("does not let assigning onDelivery silence a listener, or adding a listener replace onDelivery", async () => {
    const store = await startStore();
    const listener = vi.fn();
    const laterHandler = vi.fn();
    store.addDeliveryListener(listener);
    store.onDelivery = laterHandler;

    await store.deliver(store.peerId, freshEvent());

    expect(listener).toHaveBeenCalledTimes(1);
    expect(laterHandler).toHaveBeenCalledTimes(1);
  });

  it("delivers to a listener on its own when onDelivery was never set", async () => {
    const store = await startStore();
    const listener = vi.fn();
    store.addDeliveryListener(listener);

    await store.deliver(store.peerId, freshEvent());

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("stops giving events to a listener once it unsubscribes", async () => {
    const store = await startStore();
    const listener = vi.fn();
    const unsubscribe = store.addDeliveryListener(listener);
    await store.deliver(store.peerId, freshEvent());
    unsubscribe();

    await store.deliver(store.peerId, freshEvent());

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("reports a listener that throws or rejects through onError and still calls the others", async () => {
    const store = await startStore();
    const errors: unknown[] = [];
    store.onError = (error) => {
      errors.push(error);
    };
    const failure = new Error("listener failed");
    const healthy = vi.fn();
    store.addDeliveryListener(() => {
      throw failure;
    });
    store.addDeliveryListener(async () => Promise.reject(failure));
    store.addDeliveryListener(healthy);

    await store.deliver(store.peerId, freshEvent());
    await vi.waitFor(() => {
      expect(errors).toHaveLength(2);
    });

    expect(errors).toEqual([failure, failure]);
    expect(healthy).toHaveBeenCalledTimes(1);
  });
});

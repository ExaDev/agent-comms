/**
 * What a gateway does once the hub goes away (agent-comms#285): the held connection is dropped, so isConnected answers honestly and nothing keeps sending on a socket that is already gone. Runs against a real relay hub over local WebSockets rather than a fake, because the bug this covers was in which consumer of the session's own event stream observed the close.
 */

import { test, expect } from "vitest";
import { MeshStore } from "../core/mesh-store.js";
import {
  realHubOverWs,
  TeardownStack,
  waitForCondition,
} from "./hub-helpers.js";
import { wireTestTransportWithHub } from "./test-transport.js";

test("a gateway drops its held hub connection when the hub goes away", async () => {
  const teardown = new TeardownStack();
  try {
    const hub = await realHubOverWs();
    teardown.push(async () => {
      await hub.close();
    });

    const store = new MeshStore({ hubUrl: hub.url });
    const { transport } = await wireTestTransportWithHub(store);
    const errors: Error[] = [];
    store.onError = (error) => {
      errors.push(error);
    };
    teardown.push(async () => {
      await store.shutdown();
    });

    await transport.connectHub(hub.url);
    expect(transport.hub.isConnected).toBe(true);
    await waitForCondition(() => hub.connectionCount() === 1);

    await hub.close();

    await waitForCondition(() => !transport.hub.isConnected);

    // A gateway that still believed the connection was live would keep advertising onto it, and each attempt would report a send on a closed socket.
    const advertised = await store.listAgents("nobody");
    expect(advertised).toEqual([]);
    expect(errors.map((error) => error.message)).toEqual([]);
  } finally {
    await teardown.run();
  }
});
